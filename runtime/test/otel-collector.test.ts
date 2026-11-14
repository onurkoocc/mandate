// `mandate otel export` against a real OpenTelemetry Collector (spec/boundary.md "The OpenTelemetry projection", G24).
// otel.test.ts sends the export to a receiver of its own, in this process; this file shows that a collector somebody
// else wrote takes what the export sends, and that what it wrote out is the run: the same trace, the spans of every
// event of the journal with their hashes and times, the spans of the commands and of the run, and nothing twice.
//
// It runs only when MANDATE_OTEL_COLLECTOR names a collector's base URL and MANDATE_OTEL_COLLECTOR_OUT the file its
// `file` exporter writes (one line of OTLP JSON for each request it took). CI starts the collector in a container and
// sets both (runtime/test/otel-collector.yaml is its configuration); nowhere else is a collector assumed, so the test is
// skipped. The test makes a run the way cli.test.ts does, over PGlite in a directory, and the ground truth it compares
// with is the run's journal, read by `mandate journal export`.

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { eventSpanId, otelEndpoint, spanId, traceId } from "../src/otel.js";

const ENDPOINT = process.env["MANDATE_OTEL_COLLECTOR"];
const OUT = process.env["MANDATE_OTEL_COLLECTOR_OUT"];

// ── what the collector's file exporter writes ───────────────────────────

type Value = { stringValue?: string; intValue?: string | number };
type Attrs = Array<{ key: string; value: Value }>;

interface WrittenSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attrs;
  status?: { code?: number | string };
}

interface Written {
  resourceSpans: Array<{ resource: { attributes: Attrs }; scopeSpans: Array<{ scope: { name: string }; spans: WrittenSpan[] }> }>;
}

const attr = (a: Attrs | undefined, key: string): string | undefined => {
  const v = a?.find((x) => x.key === key)?.value;
  return v === undefined ? undefined : String(v.stringValue ?? v.intValue);
};

/** Every line the collector has written, parsed; a line that is not JSON is a failure that says which. */
function lines(file: string): Written[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, i) => {
      try {
        return JSON.parse(l) as Written;
      } catch {
        throw new Error(`line ${i + 1} of ${file} is not JSON: ${l.slice(0, 200)}`);
      }
    });
}

/** The spans of one trace in the file, with the resource and scope each was written under. */
function spansOf(file: string, trace: string): Array<{ span: WrittenSpan; service: string | undefined; scope: string }> {
  return lines(file).flatMap((l) => l.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans.filter((x) => x.traceId === trace).map((span) => ({ span, service: attr(r.resource.attributes, "service.name"), scope: s.scope.name })))));
}

async function waitFor(what: string, done: () => boolean, ms = 30_000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (done()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out after ${ms / 1000} s waiting for ${what}`);
}

// ── a run, and the CLI ──────────────────────────────────────────────────

const PROGRAM = `mandate @ 0.2

module cli.collector @ 0.1

use std.{fs, human}

type Draft = { title: Text }

capability Note = fs.read("/tmp/notes")

contract Approved(d: Draft) {
  accept owner_approved "The owner approved" by human.approve(role: "owner")
}

workflow Ship(d: Draft) -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  let reason = human.ask("Why ship it?")
  let checked = verify d against Approved(d)
  reason
}
`;

describe.skipIf(!ENDPOINT)("mandate otel export against a real OpenTelemetry Collector", () => {
  const dir = mkdtempSync(join(tmpdir(), "mandate-otel-collector-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "ship.mdt"), PROGRAM);
  writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" } }));

  async function mandate(...args: string[]): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const write = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
    try {
      const code = await main([...args, "--config", join(dir, "mandate.runtime.json")], (s) => (out += s), {});
      return { code, out, err };
    } finally {
      process.stderr.write = write;
    }
  }

  it("takes the export of a finished run, and what it wrote is the journal: its trace, every event's span with its hash and time, the command spans and the run's, each once", async () => {
    if (!OUT) throw new Error("MANDATE_OTEL_COLLECTOR is set but MANDATE_OTEL_COLLECTOR_OUT, the file the collector writes, is not");
    const endpoint = otelEndpoint(ENDPOINT!);
    const run = `collector-${randomBytes(4).toString("hex")}`;

    // A run that goes through a question, an answer, an approval and ends: succeeded, so it has its own span.
    const started = await mandate("run", join(dir, "ship.mdt"), "--workflow", "Ship", "--input", '{"d":{"title":"v1"}}', "--run-id", run);
    expect(started.code, started.err).toBe(0);
    const rev1 = started.out.match(/revision (\d+)/)![1]!;
    const answered = await mandate("answer", run, "--revision", rev1, "--by", "ann", "ready");
    expect(answered.code, answered.err).toBe(0);
    const rev2 = answered.out.match(/revision (\d+)/)![1]!;
    const approved = await mandate("approve", run, "--revision", rev2, "--by", "bob");
    expect(approved.code, approved.err).toBe(0);
    expect(approved.out).toContain("succeeded");

    // What the journal says, which is what the collector must have been told.
    const exported = await mandate("journal", "export", run);
    expect(exported.code, exported.err).toBe(0);
    const journal = JSON.parse(exported.out) as { tenant: string; events: Array<{ seq: number; type: string; at: number; hash: string | null }> };
    const events = journal.events;
    const last = events[events.length - 1]!.seq;
    expect(events.length, "the run's journal has events").toBeGreaterThan(5);

    // The export.
    const sent = await mandate("otel", "export", "--endpoint", ENDPOINT!, "--run", run, "--json");
    expect(sent.code, sent.err).toBe(0);
    const report = JSON.parse(sent.out) as { endpoint: string; runs: Array<{ run: string; events: number; posts: number; cursor: number }>; rejected: number };
    expect({ endpoint: report.endpoint, rejected: report.rejected, runs: report.runs.map((r) => ({ run: r.run, events: r.events, cursor: r.cursor })) }).toEqual({ endpoint, rejected: 0, runs: [{ run, events: events.length, cursor: last }] });
    expect(report.runs[0]!.posts, "the export made at least one post").toBeGreaterThanOrEqual(1);

    // The collector writes what it took to its file: wait until the file has the run's event spans (its flush is not
    // the export's answer), then compare all of it.
    const trace = traceId(run);
    const eventSpans = (): number => spansOf(OUT, trace).filter((s) => attr(s.span.attributes, "mandate.event.seq") !== undefined).length;
    await waitFor(`the collector's file ${OUT} to hold ${events.length} event spans of trace ${trace}`, () => eventSpans() >= events.length).catch((e: Error) => {
      throw new Error(`${e.message}; it holds ${eventSpans()} (${lines(OUT).length} lines written)`);
    });
    // The run's own span and the commands' spans go out in the same posts; give the last flush the time it needs.
    await waitFor("the run's own span", () => spansOf(OUT, trace).some((s) => s.span.name === "mandate.run"));
    const found = spansOf(OUT, trace);

    // One trace, one resource, one scope: what the export says it is.
    expect(new Set(found.map((s) => s.service)), "service.name of the resource").toEqual(new Set(["mandate"]));
    expect(new Set(found.map((s) => s.scope)), "the instrumentation scope").toEqual(new Set(["mandate.otel"]));
    expect(new Set(found.map((s) => s.span.spanId)).size, "no span is in the file twice").toBe(found.length);

    // Every event of the journal is a span of its own, with its type, hash and time, and nothing else is an event's span.
    const byId = new Map(found.map((s) => [s.span.spanId, s.span]));
    const root = spanId(run, "");
    for (const e of events) {
      const s = byId.get(eventSpanId(run, e.seq));
      expect(s, `the span of event ${e.seq} (${e.type}) is in the collector's file`).toBeDefined();
      expect({
        seq: e.seq,
        name: s!.name,
        type: attr(s!.attributes, "mandate.event.type"),
        eventSeq: attr(s!.attributes, "mandate.event.seq"),
        hash: attr(s!.attributes, "mandate.event.hash"),
        run: attr(s!.attributes, "mandate.run"),
        tenant: attr(s!.attributes, "mandate.tenant"),
        start: s!.startTimeUnixNano,
        end: s!.endTimeUnixNano,
      }).toEqual({
        seq: e.seq,
        name: e.type,
        type: e.type,
        eventSeq: String(e.seq),
        hash: e.hash ?? undefined,
        run,
        tenant: journal.tenant,
        start: String(BigInt(e.at) * 1_000_000n),
        end: String(BigInt(e.at) * 1_000_000n),
      });
    }
    const eventSeqs = found.filter((s) => attr(s.span.attributes, "mandate.event.seq") !== undefined).map((s) => Number(attr(s.span.attributes, "mandate.event.seq")));
    expect(eventSeqs.sort((a, b) => a - b), "the sequence numbers of the event spans in the file").toEqual(events.map((e) => e.seq));

    // The run's span: one, with the id of the empty command, no parent, OK, over the events up to the one that ended the run.
    const runSpans = found.filter((s) => s.span.name === "mandate.run");
    expect(runSpans.map((s) => s.span.spanId), "the run's span").toEqual([root]);
    const ended = events.find((e) => e.type === "run_succeeded");
    expect(ended, "the journal has run_succeeded").toBeDefined();
    const rs = runSpans[0]!.span;
    expect({ parent: rs.parentSpanId ?? "", status: String(rs.status?.code), events: attr(rs.attributes, "mandate.span.events"), run: attr(rs.attributes, "mandate.run") }).toEqual({
      parent: "",
      status: expect.stringMatching(/^(1|STATUS_CODE_OK)$/),
      events: String(events.filter((e) => e.seq <= ended!.seq).length),
      run,
    });

    // The commands' spans: children of the run's, each over the events that are its own, each ended before the run.
    const commandSpans = found.filter((s) => s.span.name !== "mandate.run" && attr(s.span.attributes, "mandate.event.seq") === undefined);
    expect(commandSpans.length, "the run has command spans").toBeGreaterThanOrEqual(1);
    for (const { span } of commandSpans) {
      expect({ name: span.name, parent: span.parentSpanId, command: attr(span.attributes, "mandate.command") !== undefined, events: Number(attr(span.attributes, "mandate.span.events")) >= 1, kind: attr(span.attributes, "mandate.command.kind") !== undefined }).toEqual({ name: expect.stringMatching(/^mandate\.[a-z_]+$/), parent: root, command: true, events: true, kind: true });
    }
    // The tree is whole: every parent named is a span of the file.
    for (const { span } of found) {
      if (span.parentSpanId) expect(byId.has(span.parentSpanId), `the parent ${span.parentSpanId} of span ${span.name} (${span.spanId}) is in the file`).toBe(true);
    }
    const written = found.length;
    expect(written, "spans in the file for the run: its events, its commands and the run").toBe(events.length + commandSpans.length + 1);

    // An export again sends nothing, and the collector is not told anything twice.
    const again = await mandate("otel", "export", "--endpoint", ENDPOINT!, "--run", run);
    expect([again.code, again.out]).toEqual([0, "nothing to export\n"]);
    await new Promise((r) => setTimeout(r, 1500));
    expect(spansOf(OUT, trace).length, "spans in the file after an export that had nothing to send").toBe(written);
  }, 120_000);
});
