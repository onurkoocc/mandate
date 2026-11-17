// Notifications (spec/attention.md "Notifications"): after a pass of the driver loop, the people a run of 0.7 waits
// for are told so, and, where the operator asks for it, how it ended, through channels the operator configures in
// `mandate.runtime.json` (`notifications`), never in the lock. Notifications are sent for runs of 0.7 only.
//
// - A cursor pump, in the shape of the OpenTelemetry export (otel.ts): each channel keeps a cursor per run
//   (`notify_cursors`) that only moves forward, and the pump reads the journal after the fact. Nothing is written in
//   the journal's transactions, and nothing is queued. Delivery is at least once: a receiver may get a notification
//   twice, and knows the repeat by its `id`, the same for every retry.
// - In order: a channel's cursor for a run does not move while a notification is being retried. After six failed
//   attempts it is recorded in `notify_dead` and the cursor moves past it. A way out that is not there (the egress
//   proxy does not answer, refuses the session or denies the request) is no attempt: the channel stops for the pass
//   with its cursor where it was, and the next pass tries again.
// - What is sent is fixed (`Notification`): ids, the kind, the role, the deadline, `as_of` and a link. Of an event the
//   pump reads its type, its sequence number and its time, and of the four S0 events (and `asks_exhausted`) the role
//   asked, the command and the deadline, picked out by the database (`FACTS`): nothing else of an event's data, and
//   nothing a step, a person or a model wrote, reaches this module. There is no body template.
// - Two adapters: `webhook`, an HTTPS POST that leaves only through the egress proxy, in a gateway session with a
//   credential by name, as a connector's requests do; and `file`, one JSON line per notification.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isProgram07OrLater, type WorkflowDef07 } from "@mandate/bridge";
import { eventClass } from "./classes.js";
import type { Db, Row } from "./db.js";
import { CREDENTIAL_NAME, HEADER_TOKEN, RESERVED_HEADERS, validHost } from "./egress/config.js";
import { DENIED_HEADER, EgressLink, Gateway, type GatewaySpec } from "./gateway.js";
import { Violation } from "./signals.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

export const NOTIFICATION_FORMAT = "mandate/notification/0.1";
/** The header a webhook's request carries the notification's id in. */
export const NOTIFICATION_HEADER = "x-mandate-notification";
/** How many times a notification is tried before it is given up (`notify_dead`). */
export const NOTIFY_ATTEMPTS = 6;
/** The longest one webhook request may take, from sending to its answer. */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** The wait after the first failed attempt; it doubles after each further one (1 s, 2 s, 4 s, 8 s, 16 s). */
export const NOTIFY_BACKOFF_MS = 1_000;

/**
 * The events a person is told of, with the kind of notification each makes: what is asked of a role (S0, a
 * `decision`), and how a run ended or what stopped it (S1, an `outcome`). Nothing of S2 to S4 is sent. An event is sent
 * only when the class table (`EVENT_CLASSES`) gives it the class its kind says: `asks_exhausted`, which slice B3 adds to
 * the table, is sent from then on.
 */
export const NOTIFIED: Readonly<Record<string, "decision" | "outcome">> = {
  wait_opened: "decision",
  review_requested: "decision",
  review_escalated: "decision",
  amendment_requested: "decision",
  run_succeeded: "outcome",
  run_failed: "outcome",
  run_cancelled: "outcome",
  run_attention_required: "outcome",
  budget_exceeded: "outcome",
  asks_exhausted: "outcome",
};

/** The class each kind of notification is of. */
const KIND_CLASS = { decision: "S0", outcome: "S1" } as const;

/** What a person is told: identifiers, the kind, the role, the deadline, where the run stood, and a link. */
export interface Notification {
  format: typeof NOTIFICATION_FORMAT;
  /** `digest("operation", { format, channel, run, seq })`: the same for every retry of one notification. */
  id: string;
  kind: "decision" | "outcome";
  event: string;
  class: "S0" | "S1";
  tenant: string;
  run: string;
  workflow: string;
  package: string;
  seq: number;
  at: number;
  /** The role it is addressed to on this channel: the role asked, or the owner role; for an outcome, a role that asked for it. */
  role: string | null;
  command: string | null;
  deadline: number | null;
  /** The run's revision and last event when the notification was made. */
  as_of: { revision: number; event: number };
  link: string | null;
}

/** The members of every notification, in the order it is written: nothing more and nothing less is ever sent. */
export const NOTIFICATION_MEMBERS = ["format", "id", "kind", "event", "class", "tenant", "run", "workflow", "package", "seq", "at", "role", "command", "deadline", "as_of", "link"] as const;

/** A notification that was not delivered. A retryable one is tried again, up to `NOTIFY_ATTEMPTS` in all. */
export class NotifyFailed extends Error {
  constructor(
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

/** The way out is not there: nothing was sent toward the receiver, so it is no attempt. */
export class NotifyUnavailable extends Error {}

/** One channel's adapter. `send` delivers or throws `NotifyFailed` (or `NotifyUnavailable`). */
export interface Notifier {
  name: string;
  send(n: Notification): Promise<void>;
}

// ── the configuration ─────────────────────────────────────────────────

/** A webhook channel as the configuration gives it, held to the rules of a connector's gateway. */
export interface WebhookChannel {
  /** `https://<host><path>`, as written. */
  url: string;
  host: string;
  credential: string;
  header: string;
  template: string;
  /** `mandate`: the notification as JSON; `text`: `{"text": <a fixed sentence>}`. */
  format: "mandate" | "text";
}

export type Channel = { webhook: WebhookChannel } | { file: string };

export interface NotificationsConfig {
  channels: Record<string, Channel>;
  roles: Record<string, { channels: string[]; outcomes: boolean }>;
  /** The link template: `{run}`, `{role}` and `{command}` only, each URL-encoded where it goes. */
  link: string | null;
}

/** A channel's or a role's name: letters, digits, `_` and `-`, starting with a letter, at most 64 characters. */
const NAME = CREDENTIAL_NAME;
/** The header and template a webhook's credential goes in when the channel names none, as for a connector. */
const WEBHOOK_HEADER = { header: "authorization", template: "Bearer {secret}" } as const;

/**
 * The `notifications` member of `mandate.runtime.json`, held to what can be used; anything else is refused by name,
 * `bad_notification_channel`. `at` makes a file's path absolute (relative to the configuration); `egress` says whether
 * the configuration names an egress proxy (`egress.admin`), the only way a webhook's request leaves.
 */
export function readNotifications(raw: unknown, o: { file: string; at: (p: string) => string; egress: boolean }): NotificationsConfig {
  const bad = (m: string): never => {
    throw new Violation("bad_notification_channel", `${o.file}: ${m}`);
  };
  const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
  if (!isRecord(raw)) bad(`"notifications" is { "channels", "roles", "link" }`);
  const n = raw as Record<string, unknown>;
  for (const k of Object.keys(n)) if (!["channels", "roles", "link"].includes(k)) bad(`unknown field notifications.${k}`);
  const channels: Record<string, Channel> = {};
  if (n["channels"] !== undefined && !isRecord(n["channels"])) bad(`notifications.channels maps a channel's name to { "webhook": … } or { "file": … }`);
  const files = new Map<string, string>();
  for (const [name, c] of Object.entries((n["channels"] ?? {}) as Record<string, unknown>)) {
    const at = `notifications.channels.${name}`;
    if (!NAME.test(name)) bad(`${at}: a channel's name is letters, digits, "_" and "-", starting with a letter, at most 64 characters`);
    if (!isRecord(c)) bad(`${at} is { "webhook": … } or { "file": … }`);
    const adapters = Object.keys(c as object);
    for (const k of adapters) if (k !== "webhook" && k !== "file") bad(`${at}.${k} is no adapter: a channel is a webhook or a file`);
    if (adapters.length !== 1) bad(`${at} has ${adapters.length ? "two adapters" : "no adapter"}: a channel is one webhook or one file`);
    const cr = c as Record<string, unknown>;
    if (cr["file"] !== undefined) {
      const f = cr["file"];
      if (typeof f !== "string" || f === "" || f.includes("\0")) bad(`${at}.file is the path of the file it appends to`);
      const path = o.at(f as string);
      const key = process.platform === "win32" ? path.toLowerCase() : path;
      const other = files.get(key);
      if (other !== undefined) bad(`${at}.file is the file of channel ${other} too: each file is one channel's`);
      files.set(key, name);
      channels[name] = { file: path };
      continue;
    }
    channels[name] = { webhook: webhookOf(cr["webhook"], `${at}.webhook`, bad, isRecord) };
    if (!o.egress) bad(`${at} is a webhook, whose requests leave only through the egress proxy, and egress.admin names none`);
  }
  const roles: NotificationsConfig["roles"] = {};
  if (n["roles"] !== undefined && !isRecord(n["roles"])) bad(`notifications.roles maps a role to { "channels", "outcomes" }`);
  for (const [role, r] of Object.entries((n["roles"] ?? {}) as Record<string, unknown>)) {
    const at = `notifications.roles.${role}`;
    if (!NAME.test(role)) bad(`${at}: a role's name is letters, digits, "_" and "-", starting with a letter, at most 64 characters`);
    if (!isRecord(r)) bad(`${at} is { "channels", "outcomes" }`);
    const rr = r as Record<string, unknown>;
    for (const k of Object.keys(rr)) if (k !== "channels" && k !== "outcomes") bad(`unknown field ${at}.${k}`);
    const list = rr["channels"];
    if (!Array.isArray(list) || !list.length || !list.every((x) => typeof x === "string")) bad(`${at}.channels is a list of at least one channel's name`);
    const names = list as string[];
    if (new Set(names).size !== names.length) bad(`${at}.channels names a channel twice`);
    for (const c of names) if (!Object.hasOwn(channels, c)) bad(`${at}.channels names ${JSON.stringify(c)}, which notifications.channels does not define`);
    if (rr["outcomes"] !== undefined && typeof rr["outcomes"] !== "boolean") bad(`${at}.outcomes is true or false`);
    roles[role] = { channels: [...names], outcomes: rr["outcomes"] === true };
  }
  const link = n["link"];
  if (link !== undefined) linkTemplate(link, bad);
  return { channels, roles, link: typeof link === "string" ? link : null };
}

function webhookOf(raw: unknown, at: string, bad: (m: string) => never, isRecord: (v: unknown) => v is Record<string, unknown>): WebhookChannel {
  if (!isRecord(raw)) bad(`${at} is { "url", "credential", "header", "template", "format" }`);
  const w = raw as Record<string, unknown>;
  for (const k of Object.keys(w)) if (!["url", "credential", "header", "template", "format"].includes(k)) bad(`unknown field ${at}.${k}: a webhook's body is fixed, and nothing shapes it`);
  // The URL as a connector's is held (gateway.ts `connectorGateway`): one absolute https:// URL, whose host is the
  // host it reaches as written, with no user, password, port, query or fragment.
  const url = w["url"];
  if (typeof url !== "string") return bad(`${at}.url is the webhook's https:// URL`);
  const m = /^https:\/\/([^/?#]*)([^?#]*)$/i.exec(url);
  if (!m || !/^https:/.test(url)) bad(`${at}.url is one absolute https:// URL, with no query or fragment: a webhook is reached over HTTPS only`);
  const authority = m![1]!;
  if (authority.includes("@")) bad(`${at}.url names no user or password`);
  if (/:[0-9]*$/.test(authority)) bad(`${at}.url names no port: a gateway session reaches port 443`);
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return bad(`${at}.url is one absolute https:// URL`);
  }
  if (!validHost(u.hostname) || authority.toLowerCase() !== u.hostname || u.username || u.password || u.port || u.search || u.hash) bad(`${at}.url's host is a host name or an IPv4 address, as written`);
  if (/[\x00-\x20\x7f]/.test(url)) bad(`${at}.url holds no space or control character`);
  const credential = w["credential"];
  if (credential === undefined) bad(`${at}.credential is required: the name of the credential the egress proxy puts in`);
  if (typeof credential !== "string" || !CREDENTIAL_NAME.test(credential)) bad(`${at}.credential is a credential's name, of letters, digits, _ and -, starting with a letter, at most 64 characters`);
  if ((w["header"] === undefined) !== (w["template"] === undefined)) bad(`${at} gives a header and a template together, or neither`);
  const header = w["header"] ?? WEBHOOK_HEADER.header;
  const template = w["template"] ?? WEBHOOK_HEADER.template;
  if (typeof header !== "string" || !HEADER_TOKEN.test(header) || header !== header.toLowerCase() || RESERVED_HEADERS.has(header) || header === NOTIFICATION_HEADER || header === "content-type") {
    bad(`${at}.header is a header name in lower case that neither the proxy nor the notification sets itself`);
  }
  if (typeof template !== "string" || template.split("{secret}").length !== 2 || !/^[\x20-\x7e]*$/.test(template) || template !== template.trim()) bad(`${at}.template is printable ASCII with {secret} exactly once`);
  const format = w["format"] ?? "mandate";
  if (format !== "mandate" && format !== "text") bad(`${at}.format is "mandate" (the notification as JSON) or "text" ({"text": a fixed sentence}); there is no other`);
  return { url, host: u.hostname, credential: credential as string, header: header as string, template: template as string, format: format as "mandate" | "text" };
}

/** A link template: an absolute http(s) URL whose only placeholders are `{run}`, `{role}` and `{command}`. */
function linkTemplate(link: unknown, bad: (m: string) => never): void {
  if (typeof link !== "string" || !/^https?:\/\/[^\s]+$/.test(link) || /[\x00-\x20\x7f]/.test(link)) bad(`notifications.link is an absolute http:// or https:// URL, as a template`);
  const rest = (link as string).replace(/\{(run|role|command)\}/g, "");
  const other = /\{[^}]*\}?|\}/.exec(rest);
  if (other) bad(`notifications.link may hold {run}, {role} and {command} only, and holds ${JSON.stringify(other[0])}`);
}

/** The link of a notification: the template with each placeholder replaced by its value, URL-encoded (none: empty). */
export function linkOf(template: string | null, v: { run: string; role: string | null; command: string | null }): string | null {
  if (template === null) return null;
  return template.replace(/\{(run|role|command)\}/g, (_, k: "run" | "role" | "command") => encodeURIComponent(v[k] ?? ""));
}

/** The fixed sentence of a `text` webhook, made of the notification's own members and nothing else. */
export function sentence(n: Notification): string {
  const link = n.link !== null ? ` ${n.link}` : "";
  if (n.kind === "decision") {
    const until = n.deadline === null ? "" : `, deadline ${Math.abs(n.deadline) <= 8.64e15 ? new Date(n.deadline).toISOString() : String(n.deadline)}`;
    return `Mandate: run ${n.run} of ${n.workflow} (tenant ${n.tenant}) waits for ${n.role ?? "a person"}${n.command !== null ? ` at ${n.command}` : ""}${until} (${n.event}, event ${n.seq}).${link}`;
  }
  return `Mandate: run ${n.run} of ${n.workflow} (tenant ${n.tenant}): ${n.event} (event ${n.seq}).${link}`;
}

// ── the adapters ──────────────────────────────────────────────────────

/** How a webhook channel's requests leave, for the runs of one tenant: a gateway's `fetch`, and whether it can serve. */
export interface WebhookWay {
  fetch: typeof fetch;
  /** Whether the way out holds the channel's credential; `NotifyUnavailable` when it does not answer or does not. */
  ready(): Promise<void>;
}

/** The ways out of one pass, made per channel and tenant, and closed at the end of the pass. */
export interface WebhookTransport {
  open(channel: string, spec: WebhookChannel, tenant: string): WebhookWay;
  close(): Promise<void>;
}

/**
 * The egress proxy as a webhook's way out: for each channel and tenant one gateway session to the webhook's host, POST
 * only, with the channel's credential in its header and template, as a connector's. The proxy does not open a session
 * that belongs to no run (its admin protocol requires `tenant`, `run` and `command`), so the session is opened for the
 * tenant of the run notified and the run `notify:<channel>`, a name no run of the runtime is given by the runtime: a
 * halt of the tenant (`revoke { tenant }`) cuts it as it cuts the tenant's runs', and `revoke { run: "notify:<channel>" }`
 * cuts the channel's. What a session reaches is its one destination, which the proxy holds to its own configuration
 * (`credential_not_allowed`); its scope only says what a revocation cuts. A session revoked is not replaced within the
 * pass; the next pass opens another. `send` is what the gateway sends with (a test's spy); `timeoutMs` bounds each
 * admin request.
 */
export function egressTransport(o: { admin: string; send?: typeof fetch; timeoutMs?: number; now?: () => number }): () => WebhookTransport {
  return () => {
    const ways = new Map<string, { link: EgressLink; gateway: Gateway; ready?: Promise<void> }>();
    return {
      open(channel, spec, tenant) {
        const key = JSON.stringify([channel, tenant]);
        let e = ways.get(key);
        if (!e) {
          const link = new EgressLink({ admin: o.admin, scope: { tenant, run: `notify:${channel}` }, timeoutMs: o.timeoutMs ?? NOTIFY_TIMEOUT_MS, ...(o.now ? { now: o.now } : {}) });
          const gs: GatewaySpec = { name: `notify.${channel}`, host: spec.host, methods: ["POST"], credential: spec.credential, header: spec.header, template: spec.template };
          e = { link, gateway: new Gateway(link, gs, `notify.${channel}`, o.send) };
          ways.set(key, e);
        }
        const way = e;
        return {
          fetch: way.gateway.fetch,
          ready: () =>
            (way.ready ??= way.link.ready({ [`notification channel ${channel}`]: spec.credential }).catch((x: unknown) => {
              throw new NotifyUnavailable(x instanceof Error ? x.message : String(x));
            })),
        };
      },
      async close() {
        for (const e of ways.values()) await e.link.closeAll();
      },
    };
  };
}

/** Whether an error of `fetch` is its refusal of a redirect (`redirect: "error"`). */
function redirected(e: unknown): boolean {
  const cause = (e as { cause?: { message?: unknown } }).cause;
  return typeof cause?.message === "string" && /redirect/i.test(cause.message);
}

/** A failure's cause, by its code: never a URL's path, a header or an answer's body. */
function causeOf(e: unknown): string {
  const c = (e as { cause?: { code?: unknown } }).cause;
  if (typeof c?.code === "string") return c.code;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" ? code : "the connection failed";
}

/**
 * The webhook adapter: one HTTPS POST of the notification (`mandate`) or of `{"text": <its sentence>}` (`text`), with
 * `content-type: application/json` and the notification's id in `x-mandate-notification`, through `way` and no other
 * way. A redirect is an error and is not followed; the request and its answer take 10 seconds at most; nothing of the
 * answer is read. A 2xx delivers. A 5xx, a 408, a 429, a connection that fails and no answer in time are retried; any
 * other answer, a redirect among them, gives the notification up. A denial of the egress proxy, a proxy that does not
 * answer and a session it revoked are `NotifyUnavailable`: nothing reached the receiver. A reason names the host and
 * the status or the cause, never the URL's path (which a chat webhook keeps its own secret in), a header or a body.
 */
export function webhookNotifier(channel: string, spec: WebhookChannel, way: (tenant: string) => WebhookWay): Notifier {
  if (!/^https:\/\//.test(spec.url)) throw new Violation("bad_notification_channel", `notification channel ${channel}: a webhook is reached over https:// only`);
  return {
    name: channel,
    async send(n) {
      const out = way(n.tenant);
      await out.ready();
      const body = spec.format === "text" ? JSON.stringify({ text: sentence(n) }) : JSON.stringify(n);
      const stop = AbortSignal.timeout(NOTIFY_TIMEOUT_MS);
      let res: Response;
      try {
        res = await out.fetch(spec.url, { method: "POST", headers: { "content-type": "application/json", [NOTIFICATION_HEADER]: n.id }, body, redirect: "error", signal: stop });
      } catch (e) {
        if (e instanceof Violation) throw new NotifyUnavailable(e.message);
        if (stop.aborted) throw new NotifyFailed(`${spec.host} gave no answer within ${NOTIFY_TIMEOUT_MS} ms`, true);
        if (redirected(e)) throw new NotifyFailed(`${spec.host} answered with a redirect, which is not followed`, false);
        throw new NotifyFailed(`${spec.host} could not be reached (${causeOf(e)})`, true);
      }
      // Nothing of the answer is read: what a receiver says is no part of what the runtime keeps.
      await res.body?.cancel().catch(() => undefined);
      const denied = res.headers.get(DENIED_HEADER);
      if (denied) throw new NotifyUnavailable(`the egress proxy denied the request to ${spec.host} (${denied})`);
      if (res.status >= 200 && res.status < 300) return;
      if (res.status >= 300 && res.status < 400) throw new NotifyFailed(`${spec.host} answered ${res.status}, a redirect, which is not followed`, false);
      throw new NotifyFailed(`${spec.host} answered ${res.status}`, res.status >= 500 || res.status === 408 || res.status === 429);
    },
  };
}

/** The file adapter: one JSON line per notification, appended to `path` (its directory made when missing). */
export function fileNotifier(channel: string, path: string): Notifier {
  return {
    name: channel,
    async send(n) {
      try {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, JSON.stringify(n) + "\n", "utf8");
      } catch (e) {
        throw new NotifyFailed(`could not append to ${path} (${causeOf({ cause: e })})`, true);
      }
    },
  };
}

// ── what an event makes ───────────────────────────────────────────────

/**
 * What the pump reads of an event's data, by its type, picked out by the database: of an S0 event the command, the
 * role asked and the deadline (and of `wait_opened` its kind); of `asks_exhausted` its command. Nothing else of an
 * event's data is read: `wait_opened` carries the whole request, a question's text among it, and an S1 event the run's
 * result or error.
 */
const FACTS = `case type
  when 'wait_opened' then jsonb_build_object('command', data->'command', 'kind', data->'kind', 'role', data->'request'->'role', 'deadline', data->'request'->'deadline')
  when 'review_requested' then jsonb_build_object('command', data->'node', 'role', data->'role', 'deadline', data->'deadline')
  when 'review_escalated' then jsonb_build_object('command', data->'command', 'role', data->'to', 'deadline', data->'deadline')
  when 'asks_exhausted' then jsonb_build_object('command', data->'command')
  end`;

interface Seen {
  seq: number;
  type: string;
  at: number;
  facts: Obj | null;
}

/** A run of 0.7, as the pump reads it. */
interface Run07 {
  run: string;
  tenant: string;
  workflow: string;
  package: string;
  revision: number;
  owner: string | null;
}

const text = (v: Value | undefined): string | null => (typeof v === "string" && v !== "" ? v : null);
const number = (v: Value | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The owner role of a run (spec/attention.md "Notifications"): its workflow's `owner` (0.7, which slice B6 runs), else
 * its envelope's `owner` (0.4); with neither, none. Read from the workflow's definition in the program as packaged.
 */
export function ownerRole(def: unknown): string | null {
  if (!isObj((def ?? null) as Value)) return null;
  const d = def as Partial<WorkflowDef07> & { envelope?: { owner?: unknown } };
  if (typeof d.owner === "string" && d.owner !== "") return d.owner;
  return typeof d.envelope?.owner === "string" && d.envelope.owner !== "" ? d.envelope.owner : null;
}

/**
 * Who an event is addressed to (spec/attention.md "Notifications"), or undefined when it is sent to nobody:
 *
 * - an S0 event, to the role it asks; one that asks no role, to the owner role; with no owner role, to nobody. A
 *   `wait_opened` of a review or an amendment is not sent: its `review_requested` or `amendment_requested`, written
 *   in the same transaction, is, so that one question is told once;
 * - an S1 event, to the roles configured with `outcomes: true` and to the owner role.
 *
 * Only a role the configuration names has channels; `role` is always one of its names.
 */
export function addressOf(e: Seen, pair: Seen | undefined, run: Pick<Run07, "owner">, config: NotificationsConfig): { kind: "decision" | "outcome"; roles: string[]; command: string | null; deadline: number | null } | undefined {
  const kind = Object.hasOwn(NOTIFIED, e.type) ? NOTIFIED[e.type]! : undefined;
  if (!kind || eventClass(e.type) !== KIND_CLASS[kind]) return undefined;
  const configured = (r: string | null): r is string => r !== null && Object.hasOwn(config.roles, r);
  if (kind === "outcome") {
    const roles = Object.keys(config.roles).filter((r) => config.roles[r]!.outcomes || r === run.owner).sort();
    return { kind, roles, command: e.type === "asks_exhausted" ? text(e.facts?.["command"]) : null, deadline: null };
  }
  let facts = e.facts ?? {};
  if (e.type === "wait_opened" && (facts["kind"] === "review" || facts["kind"] === "amendment")) return undefined;
  // An amendment's request, with the role it asks and its deadline, is in its wait's `wait_opened`, the next event.
  if (e.type === "amendment_requested") facts = pair && pair.type === "wait_opened" && pair.seq === e.seq + 1 && pair.facts?.["kind"] === "amendment" ? pair.facts : {};
  const asked = text(facts["role"]);
  const role = asked ?? run.owner;
  return { kind, roles: configured(role) ? [role] : [], command: text(facts["command"]), deadline: number(facts["deadline"]) };
}

/** The notification of `e` on `channel`, or undefined when the event is not addressed to a role whose channels hold it. */
export function notificationOf(channel: string, e: Seen, pair: Seen | undefined, run: Run07, lastEvent: number, config: NotificationsConfig): Notification | undefined {
  const a = addressOf(e, pair, run, config);
  if (!a) return undefined;
  const reached = a.roles.filter((r) => config.roles[r]!.channels.includes(channel));
  if (!reached.length) return undefined;
  // On a channel more than one role reaches, an outcome names the owner role if it is one of them, else the first by name.
  const role = run.owner !== null && reached.includes(run.owner) ? run.owner : reached[0]!;
  const n = {
    format: NOTIFICATION_FORMAT,
    id: digest("operation", { format: NOTIFICATION_FORMAT, channel, run: run.run, seq: e.seq }),
    kind: a.kind,
    event: e.type,
    class: KIND_CLASS[a.kind],
    tenant: run.tenant,
    run: run.run,
    workflow: run.workflow,
    package: run.package,
    seq: e.seq,
    at: e.at,
    role,
    command: a.command,
    deadline: a.deadline,
    as_of: { revision: run.revision, event: lastEvent },
    link: linkOf(config.link, { run: run.run, role, command: a.command }),
  } satisfies Notification;
  return n;
}

// ── the pump ──────────────────────────────────────────────────────────

export interface NotifyOptions {
  config: NotificationsConfig;
  /** How a webhook's requests leave, a new transport for each pass (`egressTransport`); a webhook without one sends nothing. */
  transport?: () => WebhookTransport;
  /** The time `notify_cursors` and `notify_dead` record. */
  now?: () => number;
  /** How the pump waits between two attempts; a test records the waits instead. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Stops the pass: a notification being retried stays where it is, with the cursor before it. */
  signal?: AbortSignal;
  /** How many events are read at a time. */
  batch?: number;
  onSent?: (channel: string, n: Notification) => void;
  onDead?: (d: { channel: string; run: string; seq: number; id: string; attempts: number; reason: string }) => void;
  /** Told when a channel stops for the pass, its way out not being there. */
  onFailure?: (channel: string, message: string) => void;
}

export interface NotifyReport {
  sent: number;
  /** Attempts that failed and were tried again. */
  retried: number;
  /** Notifications given up (`notify_dead`). */
  dead: number;
  /** The channels that stopped for the pass, and why. */
  failures: Array<{ channel: string; message: string }>;
}

/** The pause after failed attempt `n` (from 1). */
export function backoffMs(n: number): number {
  return NOTIFY_BACKOFF_MS * 2 ** (n - 1);
}

function waitMs(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

class Stopped extends Error {}

/** The runs of 0.7, oldest first, each with its owner role; a package's language and owner are read once per process. */
async function runs07(db: Db, known: Map<string, boolean>, owners: Map<string, string | null>): Promise<Run07[]> {
  const rows = await db.query<Row>("select run_id, tenant, workflow, package_hash, revision from runs order by created_at, run_id");
  const out: Run07[] = [];
  for (const r of rows) {
    const hash = String(r["package_hash"]);
    if (!known.has(hash)) {
      // The languages of the program and of the modules it carries, and nothing else of the package.
      const [p] = await db.query<Row>(
        "select program->'language' as language, (select coalesce(jsonb_agg(m.value->'language'), '[]'::jsonb) from jsonb_each(coalesce(p.modules, '{}'::jsonb)) m) as modules from packages p where package_hash = $1",
        [hash],
      );
      const languages = p ? [p["language"], ...(Array.isArray(p["modules"]) ? (p["modules"] as Value[]) : [])] : [];
      known.set(hash, languages.some((language) => isProgram07OrLater({ language })));
    }
    if (!known.get(hash)) continue;
    const workflow = String(r["workflow"]);
    const key = JSON.stringify([hash, workflow]);
    if (!owners.has(key)) {
      const [d] = await db.query<Row>("select program->'defs'->$2::text as def from packages where package_hash = $1", [hash, workflow]);
      const def = (d?.["def"] ?? null) as Value;
      owners.set(key, ownerRole(isObj(def) ? { owner: def["owner"], envelope: isObj(def["envelope"] ?? null) ? { owner: (def["envelope"] as Obj)["owner"] } : undefined } : null));
    }
    out.push({ run: String(r["run_id"]), tenant: String(r["tenant"]), workflow, package: hash, revision: Number(r["revision"]), owner: owners.get(key) ?? null });
  }
  return out;
}

/** The languages and owners read so far, by package: a package's hash names what it holds for good. */
const KNOWN = new WeakMap<Db, { known: Map<string, boolean>; owners: Map<string, string | null> }>();

/**
 * One notification pass: for each channel a role names, for each run of 0.7, the events after the channel's cursor
 * for the run, in order. An event addressed to none of the channel's roles moves the cursor past it; one addressed to
 * one of them is sent, tried up to `NOTIFY_ATTEMPTS` times with a backoff, and the cursor moves past it once it is
 * delivered or given up (`notify_dead`). The channels go on side by side; one channel's runs one after another.
 */
export async function notifyPass(db: Db, o: NotifyOptions): Promise<NotifyReport> {
  const report: NotifyReport = { sent: 0, retried: 0, dead: 0, failures: [] };
  const used = new Set(Object.values(o.config.roles).flatMap((r) => r.channels));
  const channels = Object.keys(o.config.channels).filter((c) => used.has(c)).sort();
  if (!channels.length || o.signal?.aborted) return report;
  let cache = KNOWN.get(db);
  if (!cache) KNOWN.set(db, (cache = { known: new Map(), owners: new Map() }));
  const runs = await runs07(db, cache.known, cache.owners);
  const transport = o.transport?.();
  const now = o.now ?? Date.now;
  const pause = o.sleep ?? waitMs;
  const batch = Math.max(2, o.batch ?? 500);
  const cursorTo = async (channel: string, run: string, seq: number): Promise<void> => {
    await db.query(
      `insert into notify_cursors (channel, run_id, seq, at) values ($1, $2, $3, $4)
       on conflict (channel, run_id) do update set seq = excluded.seq, at = excluded.at where notify_cursors.seq < excluded.seq`,
      [channel, run, seq, now()],
    );
  };

  const pump = async (channel: string): Promise<void> => {
    const c = o.config.channels[channel]!;
    const notifier: Notifier =
      "file" in c
        ? fileNotifier(channel, c.file)
        : webhookNotifier(channel, c.webhook, (tenant) => {
            if (!transport) throw new NotifyUnavailable(`channel ${channel} is a webhook, and no egress proxy is configured for it`);
            return transport.open(channel, c.webhook, tenant);
          });
    // A tenant whose way out is not there is left for the next pass; the channel's other tenants go on.
    const unavailable = new Set<string>();
    for (const run of runs) {
      if (o.signal?.aborted) return;
      if (unavailable.has(run.tenant)) continue;
      const [cur] = await db.query<Row>("select seq from notify_cursors where channel = $1 and run_id = $2", [channel, run.run]);
      let cursor = cur ? Number(cur["seq"]) : 0;
      const [m] = await db.query<Row>("select max(seq) as newest from events where run_id = $1", [run.run]);
      const last = m?.["newest"] === null || m?.["newest"] === undefined ? 0 : Number(m["newest"]);
      if (last <= cursor) continue;
      let moved = cursor;
      try {
        while (cursor < last) {
          const page = (await db.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq > $2 and seq <= $3 order by seq limit $4`, [run.run, cursor, last, batch])).map(
            (r): Seen => ({ seq: Number(r["seq"]), type: String(r["type"]), at: Number(r["at"]), facts: isObj((r["facts"] ?? null) as Value) ? (r["facts"] as Obj) : null }),
          );
          if (!page.length) break;
          for (let i = 0; i < page.length; i++) {
            const e = page[i]!;
            let pair = page[i + 1];
            if (e.type === "amendment_requested" && !pair) {
              const [next] = await db.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq = $2`, [run.run, e.seq + 1]);
              pair = next ? { seq: Number(next["seq"]), type: String(next["type"]), at: Number(next["at"]), facts: isObj((next["facts"] ?? null) as Value) ? (next["facts"] as Obj) : null } : undefined;
            }
            const n = notificationOf(channel, e, pair, run, last, o.config);
            if (n) {
              // What came before it is done: the cursor stands before it while it is tried.
              if (moved > cursor) await cursorTo(channel, run.run, moved);
              cursor = moved;
              const outcome = await deliver(notifier, n);
              if (outcome === "sent") {
                report.sent++;
                o.onSent?.(channel, n);
              } else {
                await db.query("insert into notify_dead (channel, run_id, seq, attempts, reason, at) values ($1, $2, $3, $4, $5, $6) on conflict (channel, run_id, seq) do nothing", [
                  channel,
                  run.run,
                  e.seq,
                  outcome.attempts,
                  outcome.reason,
                  now(),
                ]);
                report.dead++;
                o.onDead?.({ channel, run: run.run, seq: e.seq, id: n.id, attempts: outcome.attempts, reason: outcome.reason });
              }
              await cursorTo(channel, run.run, e.seq);
              cursor = e.seq;
            }
            moved = e.seq;
          }
          if (moved > cursor) await cursorTo(channel, run.run, moved);
          cursor = moved;
        }
      } catch (e) {
        // The cursor stands before the notification that was being tried: it is tried again by the next pass.
        if (e instanceof Stopped) return;
        if (!(e instanceof NotifyUnavailable)) throw e;
        unavailable.add(run.tenant);
        report.failures.push({ channel, message: e.message });
        o.onFailure?.(channel, e.message);
      }
    }
  };

  /** Tries `n` until it is delivered or given up; a way out that is not there is thrown on, as no attempt. */
  const deliver = async (notifier: Notifier, n: Notification): Promise<"sent" | { attempts: number; reason: string }> => {
    for (let attempt = 1; ; attempt++) {
      try {
        await notifier.send(n);
        return "sent";
      } catch (e) {
        if (!(e instanceof NotifyFailed)) throw e;
        if (!e.retryable || attempt >= NOTIFY_ATTEMPTS) return { attempts: attempt, reason: e.reason };
        report.retried++;
        await pause(backoffMs(attempt), o.signal);
        if (o.signal?.aborted) throw new Stopped();
      }
    }
  };

  try {
    await Promise.all(channels.map((c) => pump(c)));
  } finally {
    await transport?.close();
  }
  return report;
}
