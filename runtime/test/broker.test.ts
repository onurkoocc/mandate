// The read broker and run modes (design doc 9 §5; BACKLOG item 34, B6).
// Declared reads run in the control plane against a replica (PGlite here)
// and log files; values are bound, never spliced; only declared fields come
// back, masked above the caller's class. Kervan's incident review runs in
// read_only mode: real reads, masked data, nothing written, and replay never
// asks the broker again. read_only and design runs commit nothing, and the
// shadow comparison says what a read_only run would have done (V19).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bind, DeclaredReads, SampleReads, type SqlRunner } from "../src/broker.js";
import { Runtime } from "../src/runtime.js";
import { SimAgents, SimTool } from "../src/sim.js";
import { isObj, type Obj } from "../src/values.js";
import { shadowDiff } from "../src/views.js";
import { closeAll, world } from "./helpers.js";
import { kervanModules, lockFor } from "./kervan.js";
import { LAND } from "./kervan-changeset.js";

const INCIDENT = readFileSync(new URL("../../examples/kervan/programs/incident.mdt", import.meta.url), "utf8");
const dir = mkdtempSync(join(tmpdir(), "mandate-broker-"));
let replica: PGlite;

/** PGlite as the replica, every statement in a read-only transaction like the real broker's. */
const runner: SqlRunner = {
  async query(sql, params) {
    return replica.transaction(async (tx) => {
      await tx.query("set transaction read only");
      return (await tx.query<Record<string, unknown>>(sql, params)).rows;
    });
  },
};

beforeAll(async () => {
  replica = new PGlite();
  await replica.exec(`
    create table customers (id int primary key, full_name text, phone text, email text);
    create table shipments (tracking_no text primary key, customer_id int, status text, destination_city text);
    create table deliveries (tracking_no text primary key, delivery_date date, status text, attempts int);
    create table shipment_events (tracking_no text, at timestamptz, description text);
    create view v_shipment_overview as select s.tracking_no, s.status, s.destination_city, d.delivery_date::text as delivery_date, d.status as delivery_status, d.attempts, c.full_name, c.phone, c.email
      from shipments s join customers c on c.id = s.customer_id left join deliveries d on d.tracking_no = s.tracking_no;
    insert into customers values (1, 'Ayşe Demir', '+90 532 000 4821', 'ayse@example.test');
    insert into shipments values ('KRV20000001', 1, 'OUT_FOR_DELIVERY', 'Izmir');
    insert into deliveries values ('KRV20000001', '2026-10-12', 'SCHEDULED', 0);
    insert into shipment_events values ('KRV20000001', '2026-10-08T22:00:00Z', 'Marked out for delivery by batch 7');
  `);
  mkdirSync(join(dir, "logs"), { recursive: true });
  writeFileSync(join(dir, "logs", "mcp.jsonl"), [
    { ts: "2026-10-08T23:00:00Z", level: "error", service: "mcp", msg: "reschedule_delivery failed", tool: "reschedule_delivery", status: 409, trace_id: "t1" },
    { ts: "2026-10-07T10:00:00Z", level: "error", service: "mcp", msg: "older error", tool: "get_shipment", status: 500, trace_id: "t0" },
    { ts: "2026-10-09T08:00:00Z", level: "info", service: "mcp", msg: "ok", tool: "get_shipment", status: 200, trace_id: "t2" },
  ].map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(dir, "logs", "core.jsonl"), JSON.stringify({ ts: "2026-10-08T22:30:00Z", level: "warn", service: "core", msg: "reschedule refused: not_reschedulable", tool: "", status: 409, trace_id: "t1" }) + "\n");
});

afterAll(async () => {
  await replica.close();
  rmSync(dir, { recursive: true, force: true });
  await closeAll();
});

const broker = () => new DeclaredReads({ "prod_sim/core": { url: "pglite:replica", logs: join(dir, "logs") }, "prod_sim/mcp": { logs: join(dir, "logs") } }, { sql: () => runner, clock: () => 1_900_000_000_000 });
const fields = { tracking_no: "internal", status: "internal", destination_city: "internal", delivery_date: "internal", delivery_status: "internal", attempts: "internal", full_name: "confidential", phone: "confidential", email: "confidential" } as const;
const overview = (params: Record<string, string>, maxClass: "internal" | "confidential") => ({
  environment: "prod_sim",
  read: "shipment_overview",
  from: "core",
  query: { sql: "select tracking_no, status, destination_city, delivery_date, delivery_status, attempts, full_name, phone, email from v_shipment_overview where tracking_no = :tracking_no" },
  params,
  maxRows: 1,
  fields,
  maxClass,
  commandId: "c",
});

describe("DeclaredReads", () => {
  it("binds values as parameters, never as query text", () => {
    expect(bind("select a from t where x = :x and y = :y or x = :x", { x: 1, y: "b" })).toEqual({ text: "select a from t where x = $1 and y = $2 or x = $1", values: [1, "b"] });
    expect(bind("select a::text from t where x = :x", { x: 1 }).text).toBe("select a::text from t where x = $1");
    expect(() => bind("select a from t where x = :x", {})).toThrow(/no value for :x/);
  });

  it("returns only the declared fields, masked above the caller's class", async () => {
    const r = await broker().query(overview({ tracking_no: "KRV20000001" }, "internal"));
    expect(r).toMatchObject({ ok: { masked: ["email", "full_name", "phone"], truncated: false, row_count: 1, as_of: 1_900_000_000_000 } });
    const row = ((r as { ok: Obj }).ok["rows"] as Obj[])[0]!;
    expect(row).toEqual({ tracking_no: "KRV20000001", status: "OUT_FOR_DELIVERY", destination_city: "Izmir", delivery_date: "2026-10-12", delivery_status: "SCHEDULED", attempts: 0, full_name: { $masked: "confidential" }, phone: { $masked: "confidential" }, email: { $masked: "confidential" } });
    const all = await broker().query(overview({ tracking_no: "KRV20000001" }, "confidential"));
    expect(((all as { ok: Obj }).ok["rows"] as Obj[])[0]!["full_name"]).toBe("Ayşe Demir");
  });

  it("treats a model's text as a value: an injection attempt finds nothing and changes nothing", async () => {
    const r = await broker().query(overview({ tracking_no: "KRV20000001' or '1'='1" }, "internal"));
    expect((r as { ok: Obj }).ok["row_count"]).toBe(0);
    expect((await replica.query("select count(*)::int as n from customers")).rows).toEqual([{ n: 1 }]);
  });

  it("filters log lines by the declared filter over their fields and the read's parameters", async () => {
    const filter = { op: "binary", bop: "and", left: { op: "binary", bop: "==", left: { op: "var", name: "level" }, right: { op: "text", value: "error" } }, right: { op: "binary", bop: ">=", left: { op: "var", name: "ts" }, right: { op: "var", name: "since" } } };
    const r = await broker().query({ environment: "prod_sim", read: "mcp_errors", from: "mcp", query: { logs: filter }, params: { since: "2026-10-08T00:00:00Z" }, maxRows: 500, fields: { ts: "internal", level: "internal", service: "internal", msg: "internal", tool: "internal", status: "internal", trace_id: "internal" }, maxClass: "internal", commandId: "c" });
    expect(((r as { ok: Obj }).ok["rows"] as Obj[]).map((x) => x["trace_id"])).toEqual(["t1"]);
  });
});

/** Kervan's incident review, the investigator scripted. */
async function incident(mode: "read_only" | "live") {
  const modules = kervanModules();
  const agents = new SimAgents().on("Investigator.analyze", () => ({ ok: { root_cause: "a batch marked Izmir deliveries out for delivery early", evidence: ["t1"], affected_cities: ["Izmir"] }, cost: { steps: 3 } }));
  const w = await world(INCIDENT, { modules, lock: lockFor(modules), agents });
  w.adapters.broker = broker();
  const rt = new Runtime(w.db, w.adapters);
  const run = await rt.startRun({ pkg: w.pkg, workflow: "Investigate", input: { incident: { since: "2026-10-08T00:00:00Z", tracking_no: "KRV20000001" } }, mode });
  return { w, rt, run, agents };
}

describe("Kervan's incident review, read_only (B6)", () => {
  it("reads through the broker with the customers masked, writes nothing, and replays without the broker", async () => {
    const { w, rt, run, agents } = await incident("read_only");
    expect(run.state, JSON.stringify(run.error ?? run.attention)).toBe("succeeded");
    expect((run.manifest as Obj)["mode"]).toBe("read_only");
    const seen = agents.calls[0]!.args;
    expect((seen[0] as Obj[]).map((l) => l["trace_id"])).toEqual(["t1"]);
    expect((seen[3] as Obj[])[0]!["full_name"]).toEqual({ $masked: "confidential" });
    // No customer's name, phone or email anywhere in what the run recorded.
    const recorded = JSON.stringify([await w.db.query("select * from commands where run_id = $1", [run.run_id]), await w.db.query("select * from events where run_id = $1", [run.run_id])]);
    expect(recorded).not.toContain("Ayşe");
    expect(recorded).not.toContain("4821");
    expect(await w.db.query("select * from actions where run_id = $1", [run.run_id])).toEqual([]);
    // Replay reads the journal: the refusing adapters would stop it if it asked the broker.
    expect(await rt.replayRun(run.run_id)).toMatchObject({ status: "complete" });
  });
});

describe("read_only and design runs commit nothing (doc 9 §5.2, V19)", () => {
  async function landWorld() {
    const modules = kervanModules();
    const merge = new SimTool("git.merge", "reconcilable");
    return { w: await world(LAND, { modules, lock: lockFor(modules), tools: [merge] }), merge };
  }

  /** Runs Land to its end, approving whatever it asks. */
  async function landIn(w: Awaited<ReturnType<typeof landWorld>>["w"], mode: "read_only" | "design" | "live", runId: string) {
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "t" }, runId, mode });
    for (let i = 0; run.state === "waiting"; i++) {
      const wt = run.waiting as Obj;
      const r = wt["request"] as Obj;
      run = await w.rt.decideAction(runId, { sender: "p", messageId: `${runId}${i}` }, { commandId: String(wt["command"]), revision: run.revision, digest: String(r["action_digest"]), approve: true, by: String(r["role"]) });
    }
    return run;
  }

  async function landRun(mode: "read_only" | "design" | "live", runId: string) {
    const { w, merge } = await landWorld();
    let run = await w.rt.startRun({ pkg: w.pkg, workflow: "Land", input: { task: "t" }, runId, mode });
    for (let i = 0; run.state === "waiting"; i++) {
      const wt = run.waiting as Obj;
      const r = wt["request"] as Obj;
      run = await w.rt.decideAction(runId, { sender: "p", messageId: `${runId}${i}` }, { commandId: String(wt["command"]), revision: run.revision, digest: String(r["action_digest"]), approve: true, by: String(r["role"]) });
    }
    return { w, run, merge };
  }

  it("a read_only change set prepares each member and stops: would apply, nothing approved or sent", async () => {
    const { w, run, merge } = await landRun("read_only", "ro1");
    expect(run.state).toBe("succeeded");
    expect(merge.prepares).toHaveLength(3);
    expect(merge.executions).toHaveLength(0);
    expect((await w.rt.journal.actions("ro1")).map((a) => a.state)).toEqual(["would_apply", "would_apply", "would_apply"]);
    const ev = await w.rt.evidence("ro1");
    expect(ev.length).toBeGreaterThan(0);
    expect(ev.every((e) => isObj(e.record) && e.record["mode"] === "read_only")).toBe(true);
  });

  it("a design run simulates its effects: nothing prepared, nothing sent", async () => {
    const { w, run, merge } = await landRun("design", "de1");
    expect(run.state).toBe("succeeded");
    expect(merge.prepares).toHaveLength(0);
    expect(await w.rt.journal.actions("de1")).toEqual([]);
  });

  it("compares a read_only run with a live one node by node: the same actions, none committed in the shadow", async () => {
    const { w, merge } = await landWorld();
    expect((await landIn(w, "read_only", "sh")).state).toBe("succeeded");
    expect((await landIn(w, "live", "lv")).state).toBe("succeeded");
    expect(merge.executions).toHaveLength(3);
    const d = await shadowDiff(w.rt, "sh", "lv");
    expect(d.a).toMatchObject({ mode: "read_only", committed: 0 });
    expect(d.b).toMatchObject({ mode: "live", committed: 3 });
    expect(d.rows.map((r) => [r.node.split("/").pop(), r.state])).toEqual([["auth", "same"], ["core", "same"], ["mcp", "same"]]);
  });

  it("refuses a design run's read without sample rows, and answers one with them", async () => {
    const modules = kervanModules();
    const agents = new SimAgents().on("Investigator.analyze", () => ({ ok: { root_cause: "?", evidence: [], affected_cities: [] }, cost: { steps: 1 } }));
    const w = await world(INCIDENT, { modules, lock: lockFor(modules), agents });
    const failed = await w.rt.startRun({ pkg: w.pkg, workflow: "Investigate", input: { incident: { since: "x", tracking_no: "KRV1" } }, mode: "design" });
    expect(failed.state).toBe("failed");
    expect(JSON.stringify(failed.error)).toContain("no_samples");
    w.adapters.samples = new SampleReads({ "prod_sim.mcp_errors": [], "prod_sim.core_warnings": [], "prod_sim.shipment_events": [], "prod_sim.shipment_overview": [{ tracking_no: "KRV1", status: "IN_TRANSIT", full_name: "Sample Person" }] });
    const ok = await new Runtime(w.db, w.adapters).startRun({ pkg: w.pkg, workflow: "Investigate", input: { incident: { since: "x", tracking_no: "KRV1" } }, mode: "design" });
    expect(ok.state).toBe("succeeded");
    expect(((agents.calls.at(-1)!.args[3] as Obj[])[0]!)["full_name"]).toEqual({ $masked: "confidential" });
  });
});
