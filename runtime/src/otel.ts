// The OpenTelemetry projection of the run journal (spec/boundary.md "The OpenTelemetry projection"; INV-17, G24).
//
// A run is a trace of three kinds of span, none of them sent twice. Every event of the journal is a span of its own, of
// no duration, sent in the pass that reads it, in sequence order. A command's span is sent once, in the pass that reads
// the event that ends it, and the run's span once, in the pass that reads the event that ends the run. A collector is
// an outside witness of the journal's sequence numbers and hashes: they leave promptly, once, in order.
//
// What leaves is built from a fixed set of fields, an allow-list: identifiers, types, classes, model ids, counts,
// sequence numbers, hashes and times. Nothing is copied from an event's `data`, and the loader reads two members of it
// only, the id of the command an event is about and the model id an adapter reports. A new event type exports its
// type, its class, its sequence number and its hash until someone adds a field for it here, on purpose.
//
// The export runs outside every run: it reads the database, takes no lease and writes no event. The one table it
// writes is `otel_cursors`, which records for each endpoint and run the last sequence number that was exported.
//
// The encoding is OTLP/HTTP with JSON bodies, written by hand (no SDK). The encoder is the small part at the top of
// this file (`attr`, `OtlpSpan`, `body`), kept in one place so that a detail of the wire format is corrected once.

import { createHash } from "node:crypto";
import { modelTiers, type Program } from "@mandate/bridge";
import { eventClass } from "./classes.js";
import type { Db, Row, Tx } from "./db.js";
import { TERMINAL } from "./journal.js";
import { Violation } from "./signals.js";

// ── the wire format ─────────────────────────────────────────────────────

/** The semantic conventions' schema URL, pinned: the attribute names below are those of this version. */
export const OTEL_SCHEMA_URL = "https://opentelemetry.io/schemas/1.37.0";

/** The instrumentation scope the spans are written under. */
export const OTEL_SCOPE = { name: "mandate.otel", version: "0.1" } as const;

type OtlpValue = { stringValue: string } | { intValue: string };
interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}

/** A string attribute. */
const text = (key: string, value: string): OtlpAttribute => ({ key, value: { stringValue: value } });
/** An integer attribute: OTLP/JSON writes a 64-bit integer as a decimal string. */
const int = (key: string, value: number): OtlpAttribute => ({ key, value: { intValue: String(value) } });

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1, internal: nothing of a run crosses a process the projection can name. */
  kind: 1;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  /** 1 is OK, 2 is ERROR. Absent while a span's outcome is not known. */
  status?: { code: 1 | 2 };
}

export interface OtlpBody {
  resourceSpans: Array<{
    resource: { attributes: OtlpAttribute[] };
    scopeSpans: Array<{ scope: { name: string; version: string }; spans: OtlpSpan[]; schemaUrl: string }>;
    schemaUrl: string;
  }>;
}

/** The request body for the spans of one run. */
export function body(spans: OtlpSpan[]): OtlpBody {
  return { resourceSpans: [{ resource: { attributes: [text("service.name", "mandate")] }, scopeSpans: [{ scope: { ...OTEL_SCOPE }, spans, schemaUrl: OTEL_SCHEMA_URL }], schemaUrl: OTEL_SCHEMA_URL }] };
}

/** A time in milliseconds as unix nanoseconds, a decimal string. */
const nanos = (ms: number): string => (BigInt(ms) * 1_000_000n).toString();

// ── identifiers (spec/boundary.md "Identifiers") ────────────────────────

const sha = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

/** The trace id of a run: the first 16 bytes of `sha256("mandate/otel-trace/0.1\n" ‖ run)`, as lower-case hex. */
export function traceId(run: string): string {
  return sha(`mandate/otel-trace/0.1\n${run}`).subarray(0, 16).toString("hex");
}

/**
 * The id of a command's span: the first 8 bytes of `sha256("mandate/otel-span/0.1\n" ‖ run ‖ "\n" ‖ command)`, as
 * lower-case hex. The run's own span is the one of the empty command: no command has an empty id.
 */
export function spanId(run: string, command: string): string {
  return sha(`mandate/otel-span/0.1\n${run}\n${command}`).subarray(0, 8).toString("hex");
}

/** The id of the span of one event: the first 8 bytes of `sha256("mandate/otel-event/0.1\n" ‖ run ‖ "\n" ‖ seq in decimal)`. */
export function eventSpanId(run: string, seq: number): string {
  return sha(`mandate/otel-event/0.1\n${run}\n${seq}`).subarray(0, 8).toString("hex");
}

// ── the classes (spec/boundary.md, INV-17) ──────────────────────────────

/** The class of an event type: S0 to S4, from the type alone. The export's own is `eventClass`, the table the role views are built from (INV-17). */
export type ClassOf = (eventType: string) => string;

// ── what the projection is given ────────────────────────────────────────

/** An event, as the projection is given it: no data, but the id of the command it is about. */
export interface EventFact {
  seq: number;
  type: string;
  at: number;
  hash: string | null;
  /** The `command` of the event's data, when it has one that is text. The only member of `data` read. */
  command: string | null;
  /** The `meta.locked` of the event's data: the model id the adapter says it called. Used only when the lock names it. */
  locked: string | null;
}

export interface CommandFact {
  id: string;
  kind: string;
  state: string;
  /** The package the command was first recorded under, when the row says. */
  package: string | null;
}

/** The models a package's lock maps its tiers to. */
export interface ModelFact {
  /** The model of the only tier the program names; absent when it names none, or more than one, or the lock pins none. */
  sole: string | null;
  /** Every model id the lock pins. */
  ids: ReadonlySet<string>;
}

export interface RunFacts {
  run: string;
  tenant: string;
  package: string;
  events: EventFact[];
  commands: CommandFact[];
  models: ReadonlyMap<string, ModelFact>;
}

/** The models of a package: from its lock, and from how many tiers its program names. */
export function modelFact(program: Program, lock: { models?: Record<string, { model: string }> }): ModelFact {
  const pinned = lock.models ?? {};
  const tiers = [...modelTiers(program)];
  const only = tiers.length === 1 ? pinned[tiers[0]!]?.model : undefined;
  return { sole: typeof only === "string" ? only : null, ids: new Set(Object.values(pinned).flatMap((m) => (typeof m.model === "string" ? [m.model] : []))) };
}

// ── the projection ──────────────────────────────────────────────────────

/** What a command's kind is, in the GenAI conventions' terms (`gen_ai.operation.name`). A kind not listed has none. */
const OPERATIONS: Record<string, string> = { infer: "chat", turn: "chat", tool: "execute_tool", delegate: "invoke_agent" };

/** The kinds whose calls go to a model: the ones that carry `gen_ai.request.model`. */
const MODEL_CALLS = new Set(["infer", "turn"]);

/**
 * A command id as an attribute. The runtime builds an id from the program's structure, so it is a path of names and
 * numbers; one that is not shaped like that is not trusted to be an identifier, and goes as the start of its hash.
 */
const SAFE_ID = /^[A-Za-z0-9_.:/@#>[\]-]{1,200}$/;
const shown = (id: string): string => (SAFE_ID.test(id) ? id : `sha256:${sha(id).subarray(0, 8).toString("hex")}`);

/** The kind of a command as a name and an attribute: a word the runtime wrote, else a stand-in. */
const KIND = /^[a-z_]{1,32}$/;
/** An event type as a span's name: the runtime's types are words in snake case; a type not shaped like one is named `mandate.event`. */
const EVENT_NAME = /^[a-z][a-z0-9_]{0,47}$/;

/**
 * The events that end a run: the one `setState` writes when a run enters a terminal state (`run_<state>`, for each state
 * of `TERMINAL`): succeeded, failed, and cancelled, which is also how a run a halt ended, and a cancelled one, end.
 * `attention_required` and the waiting states are not ends: a run leaves them.
 */
const RUN_ENDS: ReadonlySet<string> = new Set([...TERMINAL].map((s) => `run_${s}`));

/** The sequence numbers at which spans end: the run's, and each command's. */
export interface Endings {
  /** The first event that ends the run, when the run has ended. A run that leaves a terminal state and ends again does not end twice. */
  run: number | undefined;
  /**
   * For each command with events up to its end: the `command_completed` event that ends it, else the event that ends
   * the run. A completion after the run's end is no end: the span went out with the run's.
   */
  commands: ReadonlyMap<string, number>;
}

/** Which event ends which span, from the journal alone. */
export function endings(f: RunFacts): Endings {
  const known = new Set(f.commands.map((c) => c.id));
  const run = f.events.find((e) => RUN_ENDS.has(e.type))?.seq;
  const first = new Map<string, number>();
  const completed = new Map<string, number>();
  for (const e of f.events) {
    if (e.command === null || !known.has(e.command)) continue;
    if (!first.has(e.command)) first.set(e.command, e.seq);
    if (e.type === "command_completed" && !completed.has(e.command)) completed.set(e.command, e.seq);
  }
  const commands = new Map<string, number>();
  for (const [id, began] of first) {
    const done = completed.get(id);
    const end = done !== undefined && (run === undefined || done <= run) ? done : run;
    if (end !== undefined && began <= end) commands.set(id, end);
  }
  return { run, commands };
}

/**
 * The spans of one run for the events after `after` up to `upTo`, in the order they are sent:
 *
 * - a span of its own for each event of the window, of no duration, in sequence order. Its parent is the span of the
 *   command its data names, when that is a command of the run, and the run's span otherwise;
 * - the span of each command whose ending event is in the window, by that event, from its first event to its end;
 * - the run's span, when the event that ends the run is in the window, from the run's first event to it.
 *
 * Nothing is sent twice: a span of a command or of the run is in the window of its ending event and in no other, and
 * an event after a span went out is only its own span, with that span's id as its parent. While a run is open its
 * events and its finished commands are out and its own span is not, so their parent is not yet in the collector.
 * The spans are a function of the journal and of the window: the same window gives the same spans.
 */
export function project(f: RunFacts, after: number, upTo: number, classOf: ClassOf): OtlpSpan[] {
  const commands = new Map(f.commands.map((c) => [c.id, c]));
  const trace = traceId(f.run);
  const root = spanId(f.run, "");
  const ownerOf = (e: EventFact): string => (e.command !== null && commands.has(e.command) ? e.command : "");
  const common = (c: string): OtlpAttribute[] => [text("mandate.run", f.run), text("mandate.tenant", f.tenant), text("mandate.package", commands.get(c)?.package ?? f.package)];
  const end = endings(f);

  const spans: OtlpSpan[] = f.events
    .filter((e) => e.seq > after && e.seq <= upTo)
    .map((e) => {
      const owner = ownerOf(e);
      return {
        traceId: trace,
        spanId: eventSpanId(f.run, e.seq),
        parentSpanId: owner === "" ? root : spanId(f.run, owner),
        name: EVENT_NAME.test(e.type) ? e.type : "mandate.event",
        kind: 1 as const,
        startTimeUnixNano: nanos(e.at),
        endTimeUnixNano: nanos(e.at),
        attributes: [
          ...common(owner),
          ...(owner !== "" ? [text("mandate.command", shown(owner))] : []),
          text("mandate.event.type", e.type),
          text("mandate.event.class", classOf(e.type)),
          int("mandate.event.seq", e.seq),
          ...(e.hash !== null ? [text("mandate.event.hash", e.hash)] : []),
        ],
      };
    });

  const closing = [...end.commands].filter(([, seq]) => seq > after && seq <= upTo).sort(([x, a], [y, b]) => a - b || (x < y ? -1 : 1));
  const byOwner = new Map<string, EventFact[]>();
  if (closing.length) {
    for (const e of f.events) {
      const owner = ownerOf(e);
      if (owner !== "") byOwner.set(owner, [...(byOwner.get(owner) ?? []), e]);
    }
  }
  for (const [id, seq] of closing) {
    const mine = (byOwner.get(id) ?? []).filter((e) => e.seq <= seq);
    const ended = f.events.find((e) => e.seq === seq)!;
    const c = commands.get(id)!;
    const op = OPERATIONS[c.kind];
    const known = f.models.get(c.package ?? f.package);
    const model = MODEL_CALLS.has(c.kind) ? (mine.find((e) => e.locked !== null && known?.ids.has(e.locked))?.locked ?? known?.sole ?? null) : null;
    // A status only when the command itself completed, and its row says how.
    const completed = ended.type === "command_completed" && (c.state === "succeeded" || c.state === "failed");
    spans.push({
      traceId: trace,
      spanId: spanId(f.run, id),
      parentSpanId: root,
      name: `mandate.${KIND.test(c.kind) ? c.kind : "command"}`,
      kind: 1,
      startTimeUnixNano: nanos(mine[0]!.at),
      endTimeUnixNano: nanos(ended.at),
      attributes: [...common(id), text("mandate.command", shown(id)), text("mandate.command.kind", KIND.test(c.kind) ? c.kind : "other"), ...(op ? [text("gen_ai.operation.name", op)] : []), ...(model !== null ? [text("gen_ai.request.model", model)] : []), int("mandate.span.events", mine.length)],
      ...(completed ? { status: { code: c.state === "succeeded" ? (1 as const) : (2 as const) } } : {}),
    });
  }

  if (end.run !== undefined && end.run > after && end.run <= upTo) {
    const upToEnd = f.events.filter((e) => e.seq <= end.run!);
    const last = upToEnd[upToEnd.length - 1]!;
    // A cancelled run's status is left unset: it was stopped, which is not a failure of the run and not a success.
    const status = last.type === "run_succeeded" ? 1 : last.type === "run_failed" ? 2 : undefined;
    spans.push({
      traceId: trace,
      spanId: root,
      name: "mandate.run",
      kind: 1,
      startTimeUnixNano: nanos(upToEnd[0]!.at),
      endTimeUnixNano: nanos(last.at),
      attributes: [...common(""), int("mandate.span.events", upToEnd.length)],
      ...(status !== undefined ? { status: { code: status } } : {}),
    });
  }
  return spans;
}

/**
 * The windows an export goes in, from the cursor: runs of events, each holding at most `batch` spans (an event's own,
 * and those that end with it), and at least one event. A window whose one event ends more spans than `batch` is posted
 * in several bodies, the cursor moving after the last.
 */
export function windows(f: RunFacts, after: number, batch: number): Array<{ after: number; upTo: number }> {
  const end = endings(f);
  const ending = new Map<number, number>();
  for (const seq of end.commands.values()) ending.set(seq, (ending.get(seq) ?? 0) + 1);
  if (end.run !== undefined) ending.set(end.run, (ending.get(end.run) ?? 0) + 1);
  const out: Array<{ after: number; upTo: number }> = [];
  let from = after;
  let count = 0;
  for (const e of f.events) {
    if (e.seq <= after) continue;
    const spans = 1 + (ending.get(e.seq) ?? 0);
    if (count > 0 && count + spans > batch) {
      out.push({ after: from, upTo: e.seq - 1 });
      from = e.seq - 1;
      count = 0;
    }
    count += spans;
  }
  if (count > 0) out.push({ after: from, upTo: f.events[f.events.length - 1]!.seq });
  return out;
}

// ── the endpoint ────────────────────────────────────────────────────────

/**
 * The collector's base URL, as the cursor and the posts use it: `http` or `https`, with a host, and nothing else that
 * would make the request something other than a post of spans to `<url>/v1/traces`. No user or password (the export
 * sends no credential), no query or fragment, and not the traces path itself, which is added. `http` is allowed for
 * a collector on a trusted network: the spans carry no content.
 */
export function otelEndpoint(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Violation("invalid_endpoint", `${JSON.stringify(url)} is not a URL.`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Violation("invalid_endpoint", "The endpoint is an http:// or https:// URL.");
  if (u.username !== "" || u.password !== "") throw new Violation("invalid_endpoint", "The endpoint carries no user or password: the export sends no credential.");
  if (u.search !== "" || u.hash !== "") throw new Violation("invalid_endpoint", "The endpoint has no query or fragment; /v1/traces is added to it.");
  const path = u.pathname.replace(/\/+$/, "");
  if (path.endsWith("/v1/traces")) throw new Violation("invalid_endpoint", "Give the collector's base URL: /v1/traces is added to it.");
  return `${u.origin}${path}`;
}

// ── reading a run ───────────────────────────────────────────────────────

/** What is read of a run, in one snapshot. Nothing of an event's data but the two members `EventFact` names. */
async function read(db: Db, run: string, packages: Map<string, ModelFact>): Promise<RunFacts> {
  return db.tx(async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const [r] = await tx.query<Row>("select tenant, package_hash from runs where run_id = $1", [run]);
    if (!r) throw new Violation("unknown_run", `No run '${run}'.`);
    const events = (await tx.query<Row>("select seq, type, at, hash, data->>'command' as command, data->'meta'->>'locked' as locked from events where run_id = $1 order by seq", [run])).map(
      (e): EventFact => ({ seq: Number(e["seq"]), type: String(e["type"]), at: Number(e["at"]), hash: (e["hash"] ?? null) as string | null, command: (e["command"] ?? null) as string | null, locked: (e["locked"] ?? null) as string | null }),
    );
    const commands = (await tx.query<Row>("select command_id, kind, state, package from commands where run_id = $1 order by command_id", [run])).map(
      (c): CommandFact => ({ id: String(c["command_id"]), kind: String(c["kind"]), state: String(c["state"]), package: (c["package"] ?? null) as string | null }),
    );
    const pkg = String(r["package_hash"]);
    await models(tx, [pkg, ...commands.flatMap((c) => (c.package !== null ? [c.package] : []))], packages);
    return { run, tenant: String(r["tenant"]), package: pkg, events, commands, models: packages };
  });
}

/** Reads the models of the packages not yet known: a package never changes once it is stored. */
async function models(tx: Tx, hashes: string[], into: Map<string, ModelFact>): Promise<void> {
  for (const h of new Set(hashes)) {
    if (into.has(h)) continue;
    const [p] = await tx.query<Row>("select program, lock from packages where package_hash = $1", [h]);
    if (p) into.set(h, modelFact(p["program"] as unknown as Program, (p["lock"] ?? {}) as { models?: Record<string, { model: string }> }));
  }
}

// ── the export ──────────────────────────────────────────────────────────

export interface OtelOptions {
  /** The collector's base URL, as `otelEndpoint` made it. */
  endpoint: string;
  /** One run, the runs of one tenant, or (neither) every run. */
  scope?: { run: string } | { tenant: string };
  /** Keeps exporting what is written after the export began, until `signal` aborts. */
  follow?: boolean;
  /** How long `follow` waits between two passes. */
  intervalMs?: number;
  /** Stops a `follow`, and a post in flight. */
  signal?: AbortSignal;
  /** The most spans one post carries: events, and the command and run spans that end with them. */
  batch?: number;
  /** How long one post may take, from sending to its answer read. */
  timeoutMs?: number;
  classOf?: ClassOf;
  now?: () => number;
  /** Told after each post that was accepted. */
  onPost?: (p: { run: string; from: number; to: number; spans: number }) => void;
  /** Told when a pass of `follow` failed; the next pass tries again. */
  onFailure?: (message: string) => void;
}

export interface OtelRunReport {
  run: string;
  /** The events sent in this call. */
  events: number;
  posts: number;
  /** The cursor after the call: the last sequence number exported for the endpoint. */
  cursor: number;
}

export interface OtelReport {
  endpoint: string;
  runs: OtelRunReport[];
  /** Spans the collector said it rejected: not sent again, since sending them again would be rejected the same. */
  rejected: number;
  /** The failure of the last pass of a `follow` that ended while the collector was failing. */
  failed?: string;
}

export const OTEL_BATCH = 500;
export const OTEL_TIMEOUT_MS = 10_000;
export const OTEL_INTERVAL_MS = 2_000;

/**
 * Exports runs' journals to a collector, from each run's cursor. One failed post stops the export with its run's
 * cursor where it was, and throws `otel_export_failed`; nothing of any run is touched. With `follow` a failed pass is
 * reported and tried again at the next one, and the call returns when `signal` aborts.
 */
export async function otelExport(db: Db, o: OtelOptions): Promise<OtelReport> {
  const classOf = o.classOf ?? eventClass;
  const batch = Math.max(1, o.batch ?? OTEL_BATCH);
  const packages = new Map<string, ModelFact>();
  const report: OtelReport = { endpoint: o.endpoint, runs: [], rejected: 0 };
  const entry = (run: string): OtelRunReport => {
    let e = report.runs.find((x) => x.run === run);
    if (!e) report.runs.push((e = { run, events: 0, posts: 0, cursor: 0 }));
    return e;
  };
  if (o.scope && "run" in o.scope) {
    const [known] = await db.query<Row>("select 1 as known from runs where run_id = $1", [o.scope.run]);
    if (!known) throw new Violation("unknown_run", `No run '${o.scope.run}'.`);
  }

  const pass = async (): Promise<void> => {
    const runs =
      o.scope && "run" in o.scope
        ? [o.scope.run]
        : (await db.query<Row>(o.scope ? "select run_id from runs where tenant = $1 order by created_at, run_id" : "select run_id from runs order by created_at, run_id", o.scope ? [o.scope.tenant] : [])).map((r) => String(r["run_id"]));
    for (const run of runs) {
      if (o.signal?.aborted) return;
      const [c] = await db.query<Row>("select seq from otel_cursors where endpoint = $1 and run_id = $2", [o.endpoint, run]);
      const cursor = c ? Number(c["seq"]) : 0;
      const [m] = await db.query<Row>("select max(seq) as newest from events where run_id = $1", [run]);
      const last = m?.["newest"] === null || m?.["newest"] === undefined ? 0 : Number(m["newest"]);
      const e = entry(run);
      e.cursor = cursor;
      if (last <= cursor) continue;
      const facts = await read(db, run, packages);
      for (const w of windows(facts, cursor, batch)) {
        if (o.signal?.aborted) break;
        const spans = project(facts, w.after, w.upTo, classOf);
        const events = facts.events.filter((x) => x.seq > w.after && x.seq <= w.upTo).length;
        // A window is one post unless one event ends more spans than a post carries; the cursor moves after the last.
        for (let i = 0; i < spans.length; i += batch) {
          const slice = spans.slice(i, i + batch);
          const sent = await post(o.endpoint, body(slice), o.timeoutMs ?? OTEL_TIMEOUT_MS, o.signal);
          report.rejected += sent.rejected;
          e.posts += 1;
          o.onPost?.({ run, from: w.after + 1, to: w.upTo, spans: slice.length });
        }
        // The cursor moves only after the collector accepted the window, and never back: a second exporter that is ahead stays ahead.
        await db.query(
          `insert into otel_cursors (endpoint, run_id, seq, at) values ($1, $2, $3, $4)
           on conflict (endpoint, run_id) do update set seq = excluded.seq, at = excluded.at where otel_cursors.seq < excluded.seq`,
          [o.endpoint, run, w.upTo, (o.now ?? Date.now)()],
        );
        e.events += events;
        e.cursor = w.upTo;
      }
    }
  };

  if (!o.follow) {
    try {
      await pass();
    } catch (e) {
      // An interrupt is a clean stop, not a failure: what was posted before it is in the cursors.
      if (!o.signal?.aborted) throw e;
    }
    return report;
  }
  const interval = o.intervalMs ?? OTEL_INTERVAL_MS;
  while (!o.signal?.aborted) {
    try {
      await pass();
      delete report.failed;
    } catch (e) {
      if (o.signal?.aborted) break;
      if (!(e instanceof Violation) || e.code !== "otel_export_failed") throw e;
      report.failed = e.message;
      o.onFailure?.(e.message);
    }
    await sleep(interval, o.signal);
  }
  return report;
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
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

/**
 * One post of spans: `POST <endpoint>/v1/traces` with a JSON body and nothing else but its content type: no credential
 * and no other header. A redirect is an error, so spans go where the operator said and nowhere else. Any answer but 2xx,
 * a connection that fails and a collector that does not answer in time are `otel_export_failed`; the message names the
 * status or the cause, never what was sent. A 2xx may say it rejected some spans (`partialSuccess`): they are counted.
 */
async function post(endpoint: string, payload: OtlpBody, timeoutMs: number, signal: AbortSignal | undefined): Promise<{ rejected: number }> {
  const stop = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${endpoint}/v1/traces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), redirect: "error", signal: signal ? AbortSignal.any([stop, signal]) : stop });
    const answer = await res.text();
    if (!res.ok) throw new Violation("otel_export_failed", `${endpoint} answered ${res.status}; nothing was marked as exported.`);
    try {
      const partial = (JSON.parse(answer) as { partialSuccess?: { rejectedSpans?: unknown } } | null)?.partialSuccess;
      return { rejected: typeof partial?.rejectedSpans === "number" || typeof partial?.rejectedSpans === "string" ? Number(partial.rejectedSpans) || 0 : 0 };
    } catch {
      return { rejected: 0 };
    }
  } catch (e) {
    if (e instanceof Violation) throw e;
    if (signal?.aborted) throw e;
    const why = stop.aborted ? `no answer within ${timeoutMs} ms` : ((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message);
    throw new Violation("otel_export_failed", `${endpoint} could not be reached (${why}); nothing was marked as exported.`);
  }
}
