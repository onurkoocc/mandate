// Notifications (spec/attention.md "Notifications"): after a pass of the driver loop, the people a run of 0.7 waits
// for are told so, and, where the operator asks for it, how it ended, through channels the operator configures in
// `mandate.runtime.json` (`notifications`), never in the lock. Notifications are sent for runs of 0.7 only.
//
// - A cursor pump, in the shape of the OpenTelemetry export (otel.ts): each channel keeps a cursor per run
//   (`notify_cursors`) that only moves forward, and the pump reads the journal after the fact. Nothing is written in
//   the journal's transactions, and nothing is queued. Delivery is at least once: a receiver may get a notification
//   twice, and knows the repeat by its `id`, the same for every retry.
// - One attempt per notification per pass, so that a receiver that is slow or fails never holds up the driver loop.
//   While a notification waits for its next attempt the channel's cursor for the run stands before it, so a run's
//   notifications reach a channel in order; the attempts made and the earliest time of the next one are kept with the
//   cursor, and the next attempt comes 1, 2, 4, 8 and 16 seconds later by the runtime's clock. The sixth failed attempt
//   gives it up: it is recorded in `notify_dead` and the cursor moves past it. A way out that is not there (the proxy
//   does not answer, or refuses the session) is no attempt: the channel's cursor stays, and the next pass tries again.
// - A channel that meets a run for the first time does not replay its history: it is told of the waits still open
//   (the latest question about each), and its cursor starts at the run's end.
// - A run in a halted scope is not notified, and its cursors do not move, until the halt is lifted.
// - What is sent is fixed (`Notification`): ids, the kind, the role, the deadline, `as_of` and a link. Of an event the
//   pump reads its type, its sequence number and its time, and of the four S0 events (and `asks_exhausted`) the role
//   asked, the command and the deadline, picked out by the database (`FACTS`): nothing else of an event's data, and
//   nothing a step, a person or a model wrote, reaches this module. What the starter of a run chose (the run's id, its
//   tenant) and what a lead chose (the names inside a sub-program) are carried only in a narrow form, or as a digest
//   (`carried`, `commandShown`). There is no body template.
// - Two adapters: `webhook`, an HTTPS POST that leaves only through the egress proxy, in a gateway session with a
//   credential by name, as a connector's requests do; and `file`, one JSON line per notification.

import { createHash } from "node:crypto";
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
/** How many attempts a notification is given before it is given up (`notify_dead`); one per pass at most. */
export const NOTIFY_ATTEMPTS = 6;
/** The longest one webhook request may take, from sending to its answer. */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** The wait after the first failed attempt; it doubles after each further one (1 s, 2 s, 4 s, 8 s, 16 s). */
export const NOTIFY_BACKOFF_MS = 1_000;
/** The longest URL a channel or a link template may be. */
const MAX_URL = 2048;

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

/** The S0 events: each is about one wait, by its command. */
const S0_TYPES = ["wait_opened", "review_requested", "review_escalated", "amendment_requested"] as const;

/** The class each kind of notification is of. */
const KIND_CLASS = { decision: "S0", outcome: "S1" } as const;

/** What a person is told: identifiers, the kind, the role, the deadline, where the run stood, and a link. */
export interface Notification {
  format: typeof NOTIFICATION_FORMAT;
  /** `digest("operation", { format, channel, run, seq })`, of the true run id: the same for every retry. */
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
  /** The run's revision and last event, read together when the pump came to the run. */
  as_of: { revision: number; event: number };
  link: string | null;
}

/** The members of every notification, in the order it is written: nothing more and nothing less is ever sent. */
export const NOTIFICATION_MEMBERS = ["format", "id", "kind", "event", "class", "tenant", "run", "workflow", "package", "seq", "at", "role", "command", "deadline", "as_of", "link"] as const;

/** A notification that was not delivered. A retryable one is tried again at a later pass, up to `NOTIFY_ATTEMPTS` in all. */
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

/** The pass was stopped while a notification was being sent: no attempt, and the cursor stays before it. */
class Stopped extends Error {}

/** One channel's adapter. `send` delivers or throws `NotifyFailed` (or `NotifyUnavailable`); `signal` stops it. */
export interface Notifier {
  name: string;
  send(n: Notification, signal?: AbortSignal): Promise<void>;
}

// ── what a notification may carry ─────────────────────────────────────

/**
 * The forms a value chosen outside the program may take in a notification: a run's id and a tenant (whoever starts a
 * run chooses them, as any text), a workflow's name, a command's IR path and a package's hash. Default run ids (UUIDs)
 * and ordinary tenant names are carried as they are.
 */
export const CARRIED = {
  id: /^[A-Za-z0-9._:@#~-]{1,128}$/,
  workflow: /^[A-Za-z_][A-Za-z0-9_]{0,127}$/,
  command: /^\/[A-Za-z0-9_./:@#~[\]-]{0,255}$/,
  package: /^sha256:[0-9a-f]{64}$/,
} as const;

const hex32 = (v: string): string => createHash("sha256").update(v, "utf8").digest("hex").slice(0, 32);

/**
 * `value` when it has the form `pattern` allows; otherwise `digest:` and the first 32 hex digits of the SHA-256 of its
 * UTF-8 bytes, in its place. A value that itself begins with `digest:` is replaced too, so that none can pass for
 * another's digest. An operator finds the run a digest stands for in the database, e.g. `select run_id from runs where
 * left(encode(sha256(convert_to(run_id, 'UTF8')), 'hex'), 32) = '<32 hex>'` (and `tenant` alike).
 */
export function carried(value: string, pattern: RegExp): string {
  return pattern.test(value) && !value.startsWith("digest:") ? value : `digest:${hex32(value)}`;
}

/**
 * A wait's command as a notification carries it. A wait inside a lead's sub-program has a command that holds the names
 * the lead (a model) chose for its definitions: it is carried as the command the sub-program was admitted under (the
 * `plan` node the author wrote, and the sub-program's number), followed by a digest of the rest, so that two waits of
 * one sub-program still differ. `admitted` are the commands of the run's admitted sub-programs (`program_admitted`).
 */
export function commandShown(command: string | null, admitted: readonly string[]): string | null {
  if (command === null) return null;
  const inside = admitted.filter((p) => command.startsWith(`${p}/`)).sort((a, b) => b.length - a.length)[0];
  return carried(inside === undefined ? command : `${inside}/digest:${hex32(command.slice(inside.length + 1))}`, CARRIED.command);
}

// ── the configuration ─────────────────────────────────────────────────

/**
 * A webhook channel as the configuration gives it, held to the rules of a connector's gateway. Its URL is no place
 * for a secret: it is in the runtime's configuration, and the credential goes in through the proxy. A receiver that
 * keeps its secret in its URL (the incoming webhooks of Slack and Teams) is not supported by this design.
 */
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
  /** The link template: `{run}`, `{role}` and `{command}` only, after the host, each URL-encoded where it goes. */
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
  if (/[\x00-\x20\x7f]/.test(url) || url.length > MAX_URL) bad(`${at}.url holds no space or control character, and is at most ${MAX_URL} characters`);
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

/**
 * A link template: an absolute http(s) URL whose only placeholders are `{run}`, `{role}` and `{command}`, each after
 * the host (in the path, the query or the fragment), so that no value can change where the link points.
 */
function linkTemplate(link: unknown, bad: (m: string) => never): void {
  if (typeof link !== "string" || !/^https?:\/\/[^\s]+$/.test(link) || /[\x00-\x20\x7f]/.test(link) || link.length > MAX_URL) bad(`notifications.link is an absolute http:// or https:// URL, as a template, of at most ${MAX_URL} characters`);
  const rest = (link as string).replace(/\{(run|role|command)\}/g, "");
  const other = /\{[^}]*\}?|\}/.exec(rest);
  if (other) bad(`notifications.link may hold {run}, {role} and {command} only, and holds ${JSON.stringify(other[0])}`);
  const s = link as string;
  const end = s.slice(s.indexOf("//") + 2).search(/[/?#]/);
  // A link with no path is a link; a placeholder before the path, the query or the fragment would choose where it points.
  const authority = end < 0 ? s : s.slice(0, s.indexOf("//") + 2 + end);
  if (authority.includes("{")) bad(`notifications.link has its placeholders after the host, in the path or the query: ${JSON.stringify(authority)} is where it points`);
  try {
    new URL(s.replace(/\{(run|role|command)\}/g, "x"));
  } catch {
    bad(`notifications.link is an absolute http:// or https:// URL`);
  }
}

/**
 * The link of a notification: the template with each placeholder replaced by its value, URL-encoded (none: empty).
 * A link that would point anywhere but the template's origin is none.
 */
export function linkOf(template: string | null, v: { run: string; role: string | null; command: string | null }): string | null {
  if (template === null) return null;
  const link = template.replace(/\{(run|role|command)\}/g, (_, k: "run" | "role" | "command") => encodeURIComponent(v[k] ?? ""));
  try {
    return new URL(link).origin === new URL(template.replace(/\{(run|role|command)\}/g, "")).origin ? link : null;
  } catch {
    return null;
  }
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
 * tenant of the run notified and the run `notify:<channel>`. What a session reaches is its one destination, which the
 * proxy holds to its own configuration (`credential_not_allowed`); its scope only says what a revocation cuts:
 * `revoke { tenant }` cuts the tenant's notification sessions, `revoke { run: "notify:<channel>" }` the channel's (and,
 * by the same name, a run someone named so). A halted tenant's runs are not notified at all (`notifyPass`). A session
 * revoked is not replaced within the pass; the next pass opens another. `send` is what the gateway sends with (a
 * test's spy); `timeoutMs` bounds each admin request.
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

/** The proxy's denials that are about the session, not the request: nothing reached the receiver, and none is an attempt. */
const SESSION_DENIALS = new Set(["session_revoked", "session_expired"]);

/**
 * The webhook adapter: one HTTPS POST of the notification (`mandate`) or of `{"text": <its sentence>}` (`text`), with
 * `content-type: application/json` and the notification's id in `x-mandate-notification`, through `way` and no other
 * way. A redirect is an error and is not followed; the request and its answer take `timeoutMs` (10 s) at most, and
 * `signal` stops it at once; nothing of the answer is read.
 *
 * - A 2xx delivers.
 * - A failed attempt, tried again at a later pass: a 5xx, a 408, a 429, a connection that fails, no answer in time,
 *   and a denial of this request by the egress proxy.
 * - Given up at once: any other answer, a redirect among them.
 * - No attempt (`NotifyUnavailable`): a proxy that does not answer, a session it refuses or revoked.
 *
 * A reason names the host and the status, the cause or the proxy's denial, never the URL's path, a header or a body.
 */
export function webhookNotifier(channel: string, spec: WebhookChannel, way: (tenant: string) => WebhookWay, timeoutMs = NOTIFY_TIMEOUT_MS): Notifier {
  if (!/^https:\/\//.test(spec.url)) throw new Violation("bad_notification_channel", `notification channel ${channel}: a webhook is reached over https:// only`);
  return {
    name: channel,
    async send(n, signal) {
      const out = way(n.tenant);
      await out.ready();
      const body = spec.format === "text" ? JSON.stringify({ text: sentence(n) }) : JSON.stringify(n);
      const timeout = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await out.fetch(spec.url, {
          method: "POST",
          headers: { "content-type": "application/json", [NOTIFICATION_HEADER]: n.id },
          body,
          redirect: "error",
          signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
        });
      } catch (e) {
        if (signal?.aborted) throw new Stopped();
        if (e instanceof Violation) throw new NotifyUnavailable(e.message);
        if (timeout.aborted) throw new NotifyFailed(`${spec.host} gave no answer within ${timeoutMs} ms`, true);
        if (redirected(e)) throw new NotifyFailed(`${spec.host} answered with a redirect, which is not followed`, false);
        throw new NotifyFailed(`${spec.host} could not be reached (${causeOf(e)})`, true);
      }
      // Nothing of the answer is read: what a receiver says is no part of what the runtime keeps.
      await res.body?.cancel().catch(() => undefined);
      const denied = res.headers.get(DENIED_HEADER);
      if (denied && SESSION_DENIALS.has(denied)) throw new NotifyUnavailable(`the egress proxy ended the session for ${spec.host} (${denied})`);
      if (denied) throw new NotifyFailed(`the egress proxy denied the request to ${spec.host} (${denied.slice(0, 64)})`, true);
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

/** An event as the pump reads it. */
export interface Seen {
  seq: number;
  type: string;
  at: number;
  facts: Obj | null;
}

const seenOf = (r: Row): Seen => ({ seq: Number(r["seq"]), type: String(r["type"]), at: Number(r["at"]), facts: isObj((r["facts"] ?? null) as Value) ? (r["facts"] as Obj) : null });

/** A run of 0.7, as the pump reads it: its ids, its owner role, and the channel's cursor for it. */
interface Run07 {
  run: string;
  tenant: string;
  workflow: string;
  package: string;
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
 * The wait an S0 event is about, and the role and deadline it asks, or undefined for an event that tells no question:
 * a `wait_opened` of a review or an amendment is not told, since its `review_requested` or `amendment_requested`,
 * written in the same transaction, is (one question is told once); an amendment's request, with the role it asks and
 * its deadline, is in its wait's `wait_opened`, the event after it.
 */
function questionOf(e: Seen, pair: Seen | undefined): { command: string | null; role: string | null; deadline: number | null } | undefined {
  let facts = e.facts ?? {};
  if (e.type === "wait_opened" && (facts["kind"] === "review" || facts["kind"] === "amendment")) return undefined;
  if (e.type === "amendment_requested") facts = pair && pair.type === "wait_opened" && pair.seq === e.seq + 1 && pair.facts?.["kind"] === "amendment" ? pair.facts : {};
  return { command: text(facts["command"]), role: text(facts["role"]), deadline: number(facts["deadline"]) };
}

/**
 * Who an event is addressed to (spec/attention.md "Notifications"), or undefined when it is sent to nobody:
 *
 * - an S0 event, to the role it asks; one that asks no role, to the owner role; with no owner role, to nobody;
 * - an S1 event, to the roles configured with `outcomes: true` and to the owner role.
 *
 * Only a role the configuration names has channels; `role` is always one of its names.
 */
export function addressOf(e: Seen, pair: Seen | undefined, run: Pick<Run07, "owner">, config: NotificationsConfig): { kind: "decision" | "outcome"; roles: string[]; command: string | null; deadline: number | null } | undefined {
  const kind = Object.hasOwn(NOTIFIED, e.type) ? NOTIFIED[e.type]! : undefined;
  if (!kind || eventClass(e.type) !== KIND_CLASS[kind]) return undefined;
  if (kind === "outcome") {
    const roles = Object.keys(config.roles).filter((r) => config.roles[r]!.outcomes || r === run.owner).sort();
    return { kind, roles, command: e.type === "asks_exhausted" ? text(e.facts?.["command"]) : null, deadline: null };
  }
  const q = questionOf(e, pair);
  if (!q) return undefined;
  const role = q.role ?? run.owner;
  return { kind, roles: role !== null && Object.hasOwn(config.roles, role) ? [role] : [], command: q.command, deadline: q.deadline };
}

/**
 * The notification of `e` on `channel`, or undefined when the event is not addressed to a role whose channels hold it.
 * The id is made of the true run id; every member that carries what whoever started the run chose, or what a lead
 * chose, carries its safe form (`carried`, `commandShown`), and so do the sentence and the link made of them.
 */
export function notificationOf(channel: string, e: Seen, pair: Seen | undefined, run: Run07, asOf: { revision: number; event: number }, config: NotificationsConfig, admitted: readonly string[] = []): Notification | undefined {
  const a = addressOf(e, pair, run, config);
  if (!a) return undefined;
  const reached = a.roles.filter((r) => config.roles[r]!.channels.includes(channel));
  if (!reached.length) return undefined;
  // On a channel more than one role reaches, an outcome names the owner role if it is one of them, else the first by name.
  const role = run.owner !== null && reached.includes(run.owner) ? run.owner : reached[0]!;
  const shown = { run: carried(run.run, CARRIED.id), command: commandShown(a.command, admitted) };
  return {
    format: NOTIFICATION_FORMAT,
    id: digest("operation", { format: NOTIFICATION_FORMAT, channel, run: run.run, seq: e.seq }),
    kind: a.kind,
    event: e.type,
    class: KIND_CLASS[a.kind],
    tenant: carried(run.tenant, CARRIED.id),
    run: shown.run,
    workflow: carried(run.workflow, CARRIED.workflow),
    package: carried(run.package, CARRIED.package),
    seq: e.seq,
    at: e.at,
    role,
    command: shown.command,
    deadline: a.deadline,
    as_of: asOf,
    link: linkOf(config.link, { run: shown.run, role, command: shown.command }),
  } satisfies Notification;
}

/**
 * What a channel that is new is told of a run that was there before it: for each wait still waiting, the latest S0
 * event that tells it (an escalation, rather than the request it escalated), and, of a run that needs a person now,
 * its last `run_attention_required`. Given the S0 events in order.
 */
function toldAtMeeting(s0: Seen[], open: ReadonlySet<string>, attention: number | null): Set<number> {
  const bySeq = new Map(s0.map((e) => [e.seq, e]));
  const latest = new Map<string, number>();
  for (const e of s0) {
    const q = questionOf(e, bySeq.get(e.seq + 1));
    if (q?.command && open.has(q.command)) latest.set(q.command, e.seq);
  }
  return new Set([...latest.values(), ...(attention === null ? [] : [attention])]);
}

// ── the pump ──────────────────────────────────────────────────────────

export interface NotifyOptions {
  config: NotificationsConfig;
  /** How a webhook's requests leave, a new transport for each pass (`egressTransport`); a webhook without one sends nothing. */
  transport?: () => WebhookTransport;
  /** The runtime's clock: when the next attempt of a notification may come, and the time the tables record. */
  now?: () => number;
  /** Stops the pass, a request in flight among it: a notification being sent stays where it is, with the cursor before it. */
  signal?: AbortSignal;
  /** The longest one webhook request may take (10 s). */
  timeoutMs?: number;
  /** How many events are read at a time. */
  batch?: number;
  onSent?: (channel: string, n: Notification) => void;
  onDead?: (d: { channel: string; run: string; seq: number; id: string; attempts: number; reason: string }) => void;
  /** Told when a channel stops for the pass, its way out not being there. */
  onFailure?: (channel: string, message: string) => void;
}

export interface NotifyReport {
  sent: number;
  /** Attempts of this pass that failed, each tried again at a later pass. */
  failed: number;
  /** Notifications given up (`notify_dead`). */
  dead: number;
  /** Notifications that wait for their next attempt once the pass is over, on the pass's channels. */
  pending: number;
  /** The channels whose way out was not there, and why. */
  failures: Array<{ channel: string; message: string }>;
}

/** The pause after failed attempt `n` (from 1), before attempt `n + 1` may come. */
export function backoffMs(n: number): number {
  return NOTIFY_BACKOFF_MS * 2 ** (n - 1);
}

/** The packages of 0.7, by hash: a package's hash names what it holds for good, so each is read once per process. */
const KNOWN = new WeakMap<Db, { is07: Map<string, boolean>; owners: Map<string, string | null> }>();

async function packages07(db: Db, is07: Map<string, boolean>): Promise<string[]> {
  for (const r of await db.query<Row>("select package_hash from packages")) {
    const hash = String(r["package_hash"]);
    if (is07.has(hash)) continue;
    // The languages of the program and of the modules it carries, and nothing else of the package.
    const [p] = await db.query<Row>(
      "select program->'language' as language, (select coalesce(jsonb_agg(m.value->'language'), '[]'::jsonb) from jsonb_each(coalesce(p.modules, '{}'::jsonb)) m) as modules from packages p where package_hash = $1",
      [hash],
    );
    const languages = p ? [p["language"], ...(Array.isArray(p["modules"]) ? (p["modules"] as Value[]) : [])] : [];
    is07.set(hash, languages.some((language) => isProgram07OrLater({ language })));
  }
  return [...is07].filter(([, yes]) => yes).map(([hash]) => hash);
}

interface Cursor {
  seq: number;
  start: number;
  pending: number | null;
  attempts: number;
  retryAt: number | null;
}

const cursorOf = (r: Row): Cursor | undefined =>
  r["seq"] === null || r["seq"] === undefined
    ? undefined
    : { seq: Number(r["seq"]), start: Number(r["start_seq"] ?? 0), pending: r["pending"] === null || r["pending"] === undefined ? null : Number(r["pending"]), attempts: Number(r["attempts"] ?? 0), retryAt: r["retry_at"] === null || r["retry_at"] === undefined ? null : Number(r["retry_at"]) };

/** The advisory lock key under which a channel's first pass is made, once, whatever pumps race for it. */
const MEET_LOCK = 1835297107;

/**
 * How long a pump holds the attempt it claimed before another may take it: a request's limit and a second. A claim
 * further ahead of now than this and the largest backoff together was made by a clock that has stepped back since,
 * and is taken as due.
 */
const claimMs = (timeoutMs: number): number => timeoutMs + 1_000;
const aheadMs = (timeoutMs: number): number => Math.max(backoffMs(NOTIFY_ATTEMPTS - 1), claimMs(timeoutMs));

/**
 * One notification pass. For each channel a role names (the channels side by side):
 *
 * - **A channel that is new** (no row of it in `notify_channels`) is met once, in one transaction, before anything is
 *   sent on it: every run of 0.7 there is gets the channel's cursor at the run's end, but for the waits still open and
 *   the runs that need a person now, whose latest question (or `run_attention_required`) it is told; then the channel
 *   is recorded as in use. From then on a run without a cursor for the channel is one that began after the channel
 *   was in use, and it is told from its first event, however short it lived. A run created while the meeting goes on
 *   is not in it, has no cursor when it is done, and so is new.
 * - Then for each run of 0.7 with something new past the channel's cursor (one run after another), in the run's
 *   order: a run in a halted scope (its tenant, or every tenant) is skipped, and nothing of it moves, the halt asked
 *   again before each send; an event addressed to none of the channel's roles moves the cursor past it; one addressed
 *   to one of them is sent once in the pass, by the pump that claimed its attempt: delivered, the cursor moves past
 *   it; failed, it waits for a later pass with the cursor before it and the run's later events behind it, or, failed
 *   for the sixth time or for good, it is given up (`notify_dead`) and the cursor moves past it. A failed attempt ends
 *   the channel's pass: its receiver does not answer as it should, and is not asked again until the next pass.
 *
 * A channel removed from the configuration and given again under the same name goes on from its cursors.
 */
export async function notifyPass(db: Db, o: NotifyOptions): Promise<NotifyReport> {
  const report: NotifyReport = { sent: 0, failed: 0, dead: 0, pending: 0, failures: [] };
  const used = new Set(Object.values(o.config.roles).flatMap((r) => r.channels));
  const channels = Object.keys(o.config.channels).filter((c) => used.has(c)).sort();
  if (!channels.length || o.signal?.aborted) return report;
  let cache = KNOWN.get(db);
  if (!cache) KNOWN.set(db, (cache = { is07: new Map(), owners: new Map() }));
  const owners = cache.owners;
  const hashes = await packages07(db, cache.is07);
  const transport = o.transport?.();
  const now = o.now ?? Date.now;
  const batch = Math.max(2, o.batch ?? 500);
  const timeoutMs = o.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  /** As a start or a resume asks (journal.ts `openHalt`): a halt of this tenant, or of every tenant, not lifted. */
  const halted = async (tenant: string): Promise<boolean> => (await db.query<Row>("select 1 as halted from halts where lifted_at is null and (tenant is null or tenant = $1) limit 1", [tenant])).length > 0;
  const ownerOf = async (q: Pick<Db, "query">, hash: string, workflow: string): Promise<string | null> => {
    const key = JSON.stringify([hash, workflow]);
    if (!owners.has(key)) {
      const [d] = await q.query<Row>("select program->'defs'->$2::text as def from packages where package_hash = $1", [hash, workflow]);
      const def = (d?.["def"] ?? null) as Value;
      owners.set(key, ownerRole(isObj(def) ? { owner: def["owner"], envelope: isObj(def["envelope"] ?? null) ? { owner: (def["envelope"] as Obj)["owner"] } : undefined } : null));
    }
    return owners.get(key) ?? null;
  };
  const s0Of = async (q: Pick<Db, "query">, run: string, after: number, upTo: number): Promise<Seen[]> =>
    (await q.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq > $2 and seq <= $3 and type = any($4::text[]) order by seq`, [run, after, upTo, [...S0_TYPES]])).map(seenOf);
  /** What a run still asks, as the meeting of a channel tells it: its open waits, and the attention it needs now. */
  const asksNow = async (q: Pick<Db, "query">, run: string, upTo: number): Promise<Set<number>> => {
    const open = new Set((await q.query<Row>("select command_id from commands where run_id = $1 and state = 'waiting'", [run])).map((x) => String(x["command_id"])));
    const [att] = await q.query<Row>(
      "select (select max(seq) from events e where e.run_id = r.run_id and e.type = 'run_attention_required' and e.seq <= $2) as seq from runs r where r.run_id = $1 and r.state = 'attention_required'",
      [run, upTo],
    );
    const attention = att && att["seq"] !== null && att["seq"] !== undefined ? Number(att["seq"]) : null;
    return toldAtMeeting(await s0Of(q, run, 0, upTo), open, attention);
  };

  /**
   * The first pass of a new channel (see above), made once: under an advisory lock of the channel, the row in
   * `notify_channels` is looked for again, so of two pumps that race for it one meets the channel and the other finds
   * it met.
   */
  const meet = async (channel: string): Promise<void> => {
    if ((await db.query<Row>("select 1 as met from notify_channels where channel = $1", [channel])).length) return;
    await db.tx(async (tx) => {
      await tx.query(`select pg_advisory_xact_lock(${MEET_LOCK}, hashtext($1))`, [channel]);
      if ((await tx.query<Row>("select 1 as met from notify_channels where channel = $1", [channel])).length) return;
      // Every run there is now, at its end, in one statement: a run it does not see began after it.
      const placed = await tx.query<Row>(
        `insert into notify_cursors (channel, run_id, seq, at, start_seq)
         select $1, r.run_id, coalesce(m.last, 0), $3, coalesce(m.last, 0)
           from runs r cross join lateral (select max(seq) as last from events e where e.run_id = r.run_id) m
          where r.package_hash = any($2::text[])
         on conflict (channel, run_id) do nothing
         returning run_id, seq`,
        [channel, hashes, now()],
      );
      const at = new Map(placed.map((p) => [String(p["run_id"]), Number(p["seq"])]));
      // Of those, the ones that still ask something: they are told it, from just before it.
      const asking = at.size
        ? await tx.query<Row>(
            "select run_id, tenant, workflow, package_hash, revision from runs r where r.run_id = any($1::text[]) and (r.state = 'attention_required' or exists (select 1 from commands c where c.run_id = r.run_id and c.state = 'waiting'))",
            [[...at.keys()]],
          )
        : [];
      for (const r of asking) {
        const run: Run07 = { run: String(r["run_id"]), tenant: String(r["tenant"]), workflow: String(r["workflow"]), package: String(r["package_hash"]), owner: null };
        run.owner = await ownerOf(tx, run.package, run.workflow);
        const end = at.get(run.run)!;
        const keep = await asksNow(tx, run.run, end);
        if (!keep.size) continue;
        const seen = (await tx.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq = any($2::int[]) order by seq`, [run.run, [...keep, ...[...keep].map((s) => s + 1)]])).map(seenOf);
        const bySeq = new Map(seen.map((e) => [e.seq, e]));
        const asOf = { revision: Number(r["revision"]), event: end };
        const mine = [...keep].filter((s) => bySeq.has(s) && notificationOf(channel, bySeq.get(s)!, bySeq.get(s + 1), run, asOf, o.config) !== undefined);
        if (mine.length) await tx.query("update notify_cursors set seq = $3 where channel = $1 and run_id = $2", [channel, run.run, Math.min(...mine) - 1]);
      }
      await tx.query("insert into notify_channels (channel, at) values ($1, $2) on conflict (channel) do nothing", [channel, now()]);
    });
  };
  /** Moves the cursor past `seq`, and forgets a notification waiting for its next attempt at or before it. */
  const cursorTo = async (channel: string, run: string, seq: number): Promise<void> => {
    await db.query(
      `update notify_cursors set seq = $3, at = $4,
         attempts = case when pending is not null and pending <= $3 then 0 else attempts end,
         retry_at = case when pending is not null and pending <= $3 then null else retry_at end,
         pending = case when pending is not null and pending <= $3 then null else pending end
       where channel = $1 and run_id = $2 and seq < $3`,
      [channel, run, seq, now()],
    );
  };

  const pump = async (channel: string): Promise<void> => {
    const c = o.config.channels[channel]!;
    const notifier: Notifier =
      "file" in c
        ? fileNotifier(channel, c.file)
        : webhookNotifier(
            channel,
            c.webhook,
            (tenant) => {
              if (!transport) throw new NotifyUnavailable(`channel ${channel} is a webhook, and no egress proxy is configured for it`);
              return transport.open(channel, c.webhook, tenant);
            },
            o.timeoutMs,
          );
    await meet(channel);
    // The runs with something new past the cursor, or no cursor (begun since the channel is in use), and none whose
    // notification waits for its next attempt: chosen by the database, not read one by one.
    const runs = await db.query<Row>(
      `select r.run_id, r.tenant, r.workflow, r.package_hash, c.seq, c.start_seq, c.pending, c.attempts, c.retry_at
         from runs r left join notify_cursors c on c.channel = $1 and c.run_id = r.run_id
        where r.package_hash = any($2::text[])
          and (c.run_id is null or ((c.retry_at is null or c.retry_at <= $3 or c.retry_at > $3 + $4) and exists (select 1 from events e where e.run_id = r.run_id and e.seq > c.seq)))
        order by r.created_at, r.run_id`,
      [channel, hashes, now(), aheadMs(timeoutMs)],
    );
    // A tenant whose way out is not there, or that is halted, is left for the next pass; the other tenants go on.
    const skipped = new Set<string>();
    for (const r of runs) {
      if (o.signal?.aborted) return;
      const run: Run07 = { run: String(r["run_id"]), tenant: String(r["tenant"]), workflow: String(r["workflow"]), package: String(r["package_hash"]), owner: null };
      if (skipped.has(run.tenant)) continue;
      if (await halted(run.tenant)) {
        skipped.add(run.tenant);
        continue;
      }
      run.owner = await ownerOf(db, run.package, run.workflow);
      // Where the run stands, read at one moment: its revision and its last event.
      const [snap] = await db.query<Row>("select r.revision, (select max(seq) from events e where e.run_id = r.run_id) as last from runs r where r.run_id = $1", [run.run]);
      const asOf = { revision: Number(snap?.["revision"] ?? 0), event: Number(snap?.["last"] ?? 0) };
      const last = asOf.event;
      const admitted = (await db.query<Row>("select data->>'command' as c from events where run_id = $1 and type = 'program_admitted'", [run.run])).flatMap((x) => (typeof x["c"] === "string" ? [x["c"]] : []));
      let cur = cursorOf(r);
      if (!cur) {
        // A run begun since the channel is in use: told from its first event.
        await db.query("insert into notify_cursors (channel, run_id, seq, at, start_seq) values ($1, $2, 0, $3, 0) on conflict (channel, run_id) do nothing", [channel, run.run, now()]);
        const [again] = await db.query<Row>("select seq, start_seq, pending, attempts, retry_at from notify_cursors where channel = $1 and run_id = $2", [channel, run.run]);
        cur = again ? cursorOf(again) : undefined;
        if (!cur) continue;
      }
      if (cur.seq >= last) continue;
      // Of what came before the channel was met, only what the run still asks is told.
      const start = cur.start;
      const keep = start > cur.seq ? await asksNow(db, run.run, start) : new Set<number>();
      let cursor = cur.seq;
      let moved = cursor;
      let claimed: number | undefined;
      try {
        pages: while (cursor < last) {
          const page = (await db.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq > $2 and seq <= $3 order by seq limit $4`, [run.run, moved, last, batch])).map(seenOf);
          if (!page.length) break;
          for (let i = 0; i < page.length; i++) {
            const e = page[i]!;
            let pair = page[i + 1];
            if (e.type === "amendment_requested" && !pair) {
              const [next] = await db.query<Row>(`select seq, type, at, ${FACTS} as facts from events where run_id = $1 and seq = $2`, [run.run, e.seq + 1]);
              pair = next ? seenOf(next) : undefined;
            }
            const n = e.seq <= start && !keep.has(e.seq) ? undefined : notificationOf(channel, e, pair, run, asOf, o.config, admitted);
            if (!n) {
              moved = e.seq;
              continue;
            }
            // What came before it is done: the cursor stands before it while it is tried.
            if (moved > cursor) await cursorTo(channel, run.run, moved);
            cursor = moved;
            // A halt committed since the pass began stops its sends for the tenant.
            if (await halted(run.tenant)) {
              skipped.add(run.tenant);
              break pages;
            }
            // The attempt is claimed first, by one pump alone: the one whose conditional update returns the row.
            const [claim] = await db.query<Row>(
              `update notify_cursors set pending = $3, attempts = case when pending = $3 then attempts else 0 end, retry_at = $4 + $5, at = $4
                where channel = $1 and run_id = $2 and seq < $3 and (retry_at is null or retry_at <= $4 or retry_at > $4 + $6)
                returning attempts`,
              [channel, run.run, e.seq, now(), claimMs(timeoutMs), aheadMs(timeoutMs)],
            );
            if (!claim) break pages;
            claimed = e.seq;
            const failure = await attempt(notifier, n);
            if (failure === undefined) {
              report.sent++;
              o.onSent?.(channel, n);
            } else {
              const [kept] = await db.query<Row>("update notify_cursors set attempts = attempts + 1, at = $4 where channel = $1 and run_id = $2 and pending = $3 returning attempts", [channel, run.run, e.seq, now()]);
              if (!kept) break pages;
              const attempts = Number(kept["attempts"]);
              if (failure.retryable && attempts < NOTIFY_ATTEMPTS) {
                await db.query("update notify_cursors set retry_at = $4 where channel = $1 and run_id = $2 and pending = $3", [channel, run.run, e.seq, now() + backoffMs(attempts)]);
                claimed = undefined;
                report.failed++;
                // The receiver does not answer as it should: the channel is not asked again in this pass.
                return;
              }
              await db.query("insert into notify_dead (channel, run_id, seq, attempts, reason, at) values ($1, $2, $3, $4, $5, $6) on conflict (channel, run_id, seq) do nothing", [
                channel,
                run.run,
                e.seq,
                attempts,
                failure.reason,
                now(),
              ]);
              report.dead++;
              o.onDead?.({ channel, run: run.run, seq: e.seq, id: n.id, attempts, reason: failure.reason });
            }
            await cursorTo(channel, run.run, e.seq);
            claimed = undefined;
            cursor = moved = e.seq;
          }
          if (moved > cursor) await cursorTo(channel, run.run, moved);
          cursor = moved;
        }
      } catch (e) {
        // The cursor stands before the notification that was being sent, and its claim is given back, no attempt
        // counted: it is tried again by the next pass.
        if (claimed !== undefined) {
          await db.query("update notify_cursors set retry_at = null, pending = case when attempts = 0 then null else pending end where channel = $1 and run_id = $2 and pending = $3", [channel, run.run, claimed]);
        }
        if (e instanceof Stopped) return;
        if (!(e instanceof NotifyUnavailable)) throw e;
        skipped.add(run.tenant);
        report.failures.push({ channel, message: e.message });
        o.onFailure?.(channel, e.message);
      }
    }
  };

  /** Sends `n` once: undefined when delivered, the failure otherwise; a way out that is not there, or a stop, is thrown on. */
  const attempt = async (notifier: Notifier, n: Notification): Promise<NotifyFailed | undefined> => {
    try {
      await notifier.send(n, o.signal);
      return undefined;
    } catch (e) {
      if (o.signal?.aborted) throw new Stopped();
      if (e instanceof NotifyFailed) return e;
      throw e;
    }
  };

  try {
    // Every channel ends its pass before the ways out are closed, also when another one failed.
    const ended = await Promise.allSettled(channels.map((c) => pump(c)));
    const failed = ended.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  } finally {
    await transport?.close();
  }
  const [p] = await db.query<Row>("select count(*) as n from notify_cursors where pending is not null and channel = any($1::text[])", [channels]);
  report.pending = Number(p?.["n"] ?? 0);
  return report;
}
