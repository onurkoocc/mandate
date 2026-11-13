// The OpenTelemetry projection of the run journal (spec/boundary.md "The OpenTelemetry projection"; INV-17, G24).
//
// A run is a trace. Its commands are spans, and so is the run itself; the journal's events are the span events of the
// span they belong to. What leaves is built from a fixed set of fields, an allow-list: identifiers, types, classes,
// model ids, counts, sequence numbers, hashes and times. Nothing is copied from an event's `data`, and the loader
// reads one member of it only, the id of the command an event is about. A new event type exports its type, its class,
// its sequence number and its hash until someone adds a field for it here, on purpose.
//
// The export runs outside every run: it reads the database, takes no lease and writes no event. The one table it
// writes is `otel_cursors`, which records for each endpoint and run the last sequence number that was exported.
//
// The encoding is OTLP/HTTP with JSON bodies, written by hand (no SDK). The encoder is the small part at the top of
// this file (`attr`, `OtlpSpan`, `body`), kept in one place so that a detail of the wire format is corrected once.

import { createHash } from "node:crypto";
import { modelTiers, type Program } from "@mandate/compiler";
import type { Db, Row, Tx } from "./db.js";
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

interface OtlpEvent {
  timeUnixNano: string;
  name: string;
  attributes: OtlpAttribute[];
}

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
  events: OtlpEvent[];
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
function body(spans: OtlpSpan[]): OtlpBody {
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

// ── the classes (spec/boundary.md, INV-17) ──────────────────────────────

/** The class of an event type: S0 to S4, from the type alone. */
export type ClassOf = (eventType: string) => string;

/**
 * THE STAND-IN FOR THE SHARED CLASS TABLE. The class of each event type is assigned in one place for the role views
 * and for this export (INV-17), a function from an event type to its class that another change builds. Until both are
 * in, the export has this small table of its own, written from the table in spec/boundary.md "Views by role and the
 * audit view". When the shared table lands, `defaultClassOf` is deleted and `mandate otel export` is given that
 * table's function in its place (`otelExport`'s `classOf`); nothing else here changes.
 *
 * A type this table does not name is S4, the class only the audit view shows: a type nobody has classed is not shown
 * to anyone who is not looking at everything.
 */
const STAND_IN_CLASSES: Record<string, string> = {
  // S0: a decision, and what was asked of whom
  wait_opened: "S0",
  decision_received: "S0",
  decision_refused: "S0",
  action_authorized: "S0",
  envelope_approved: "S0",
  governance_approved: "S0",
  governance_denied: "S0",
  criterion_approved: "S0",
  criterion_denied: "S0",
  amendment_requested: "S0",
  package_amended: "S0",
  limits_raised: "S0",
  // S1: how the run ended, a fault, a violation, a halt
  run_succeeded: "S1",
  run_failed: "S1",
  run_cancelled: "S1",
  run_attention_required: "S1",
  violation: "S1",
  budget_exceeded: "S1",
  guarantee_lowered: "S1",
  sandbox_stopped: "S1",
  wait_expired: "S1",
  program_refused: "S1",
  cancel_requested: "S1",
  lease_revoked: "S1",
  egress_denied: "S1",
  // S2: progress
  run_accepted: "S2",
  run_running: "S2",
  run_waiting: "S2",
  run_cancelling: "S2",
  lease_acquired: "S2",
  map_started: "S2",
  map_ended: "S2",
  command_dispatched: "S2",
  command_completed: "S2",
  command_throttled: "S2",
  throttled: "S2",
  charge_pending: "S2",
  charge_settled: "S2",
  program_admitted: "S2",
  program_submitted: "S2",
  input_received: "S2",
  // S3: a step's detail
  action_prepared: "S3",
  action_committed: "S3",
  reconcile_requested: "S3",
  input: "S3",
  at_most_once: "S3",
};

export const defaultClassOf: ClassOf = (type) => (Object.hasOwn(STAND_IN_CLASSES, type) ? STAND_IN_CLASSES[type]! : "S4");

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

/**
 * The spans of one run for the events after `after` up to `upTo`, as one OTLP body, or none when there are no such
 * events. The run's span is always in it, so that a command's span has its parent in the same body.
 *
 * A span is sent again in a later body when later events belong to it: it has the same id, the same start, the
 * events of that body and the end of its last event so far, and `mandate.span.events`, the count of its events so
 * far, which grows. A body is a function of the journal and of the two sequence numbers, so one exported twice is
 * the same twice.
 */
export function project(f: RunFacts, after: number, upTo: number, classOf: ClassOf): OtlpBody | undefined {
  const batch = f.events.filter((e) => e.seq > after && e.seq <= upTo);
  if (!batch.length) return undefined;
  const commands = new Map(f.commands.map((c) => [c.id, c]));
  const trace = traceId(f.run);
  const root = spanId(f.run, "");
  const ownerOf = (e: EventFact): string => (e.command !== null && commands.has(e.command) ? e.command : "");
  const upToNow = f.events.filter((e) => e.seq <= upTo);
  const common = (c: string): OtlpAttribute[] => [text("mandate.run", f.run), text("mandate.tenant", f.tenant), text("mandate.package", commands.get(c)?.package ?? f.package)];

  const span = (owner: string): OtlpSpan => {
    const all = upToNow.filter((e) => ownerOf(e) === owner);
    const mine = batch.filter((e) => ownerOf(e) === owner);
    const first = (owner === "" ? upToNow[0] : all[0])!;
    const last = owner === "" ? upToNow[upToNow.length - 1]! : all[all.length - 1]!;
    const base = { traceId: trace, spanId: spanId(f.run, owner), kind: 1 as const, startTimeUnixNano: nanos(first.at), endTimeUnixNano: nanos(last.at) };
    const events: OtlpEvent[] = mine.map((e) => ({
      timeUnixNano: nanos(e.at),
      name: e.type,
      attributes: [text("mandate.event.type", e.type), text("mandate.event.class", classOf(e.type)), int("mandate.event.seq", e.seq), ...(e.hash !== null ? [text("mandate.event.hash", e.hash)] : [])],
    }));
    const count = int("mandate.span.events", owner === "" ? upToNow.length : all.length);
    if (owner === "") {
      const ended = upToNow.find((e) => e.type === "run_succeeded" || e.type === "run_failed");
      return { ...base, name: "mandate.run", attributes: [...common(""), count], events, ...(ended ? { status: { code: ended.type === "run_succeeded" ? (1 as const) : (2 as const) } } : {}) };
    }
    const c = commands.get(owner)!;
    const op = OPERATIONS[c.kind];
    const known = f.models.get(c.package ?? f.package);
    const locked = MODEL_CALLS.has(c.kind) ? all.find((e) => e.locked !== null && known?.ids.has(e.locked))?.locked ?? known?.sole ?? null : null;
    const done = all.some((e) => e.type === "command_completed") && (c.state === "succeeded" || c.state === "failed");
    return {
      ...base,
      parentSpanId: root,
      name: `mandate.${/^[a-z_]{1,32}$/.test(c.kind) ? c.kind : "command"}`,
      attributes: [...common(owner), text("mandate.command", shown(owner)), text("mandate.command.kind", /^[a-z_]{1,32}$/.test(c.kind) ? c.kind : "other"), ...(op ? [text("gen_ai.operation.name", op)] : []), ...(locked !== null ? [text("gen_ai.request.model", locked)] : []), count],
      events,
      ...(done ? { status: { code: c.state === "succeeded" ? (1 as const) : (2 as const) } } : {}),
    };
  };

  // The commands in the order their first event of this body came, after the run's own span.
  const owners = [...new Set(batch.map(ownerOf))].filter((o) => o !== "");
  return body([span(""), ...owners.map(span)]);
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
  /** The most events one post carries. */
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
  const classOf = o.classOf ?? defaultClassOf;
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
      const pending = facts.events.filter((x) => x.seq > cursor);
      for (let i = 0; i < pending.length && !o.signal?.aborted; i += batch) {
        const chunk = pending.slice(i, i + batch);
        const from = chunk[0]!.seq;
        const to = chunk[chunk.length - 1]!.seq;
        const payload = project(facts, from - 1, to, classOf)!;
        const sent = await post(o.endpoint, payload, o.timeoutMs ?? OTEL_TIMEOUT_MS, o.signal);
        report.rejected += sent.rejected;
        // The cursor moves only after the collector accepted the post, and never back: a second exporter that is ahead stays ahead.
        await db.query(
          `insert into otel_cursors (endpoint, run_id, seq, at) values ($1, $2, $3, $4)
           on conflict (endpoint, run_id) do update set seq = excluded.seq, at = excluded.at where otel_cursors.seq < excluded.seq`,
          [o.endpoint, run, to, (o.now ?? Date.now)()],
        );
        e.events += chunk.length;
        e.posts += 1;
        e.cursor = to;
        o.onPost?.({ run, from, to, spans: payload.resourceSpans[0]!.scopeSpans[0]!.spans.length });
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
