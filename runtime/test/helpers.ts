import { randomUUID } from "node:crypto";
import { check } from "@mandate/compiler";
import { expect } from "vitest";
import { ISSUE } from "./programs.js";
import type { Clock } from "../src/adapters.js";
import { openDb, type Db } from "../src/db.js";
import { Faults } from "../src/faults.js";
import { buildPackage, Runtime, type Package, type StartOptions } from "../src/runtime.js";
import { simulate, type Sim, type SimAgents, type SimModel, type SimReads, type SimTool, type SimVerifier } from "../src/sim.js";

/** Imported domain modules are pinned in every test package (S09). */
export const LOCK = { modules: { "company.domain": "sha256:0f1e" } };

export interface World extends Sim {
  rt: Runtime;
  db: Db;
  pkg: Package;
  faults: Faults;
}

let shared: Promise<Db> | undefined;

/**
 * A runtime over an empty database. One database serves a whole test file
 * (opening PGlite costs seconds) and is emptied for each world: in-process
 * PGlite by default, or a fresh schema on the PostgreSQL server named by
 * MANDATE_TEST_DATABASE_URL.
 */
export async function world(src: string, o: { tools?: SimTool[]; agents?: SimAgents; model?: SimModel; verifier?: SimVerifier; reads?: SimReads; clock?: Clock } = {}): Promise<World> {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  const url = process.env["MANDATE_TEST_DATABASE_URL"];
  shared ??= openDb(url, url ? `t_${randomUUID().replaceAll("-", "")}` : undefined);
  const db = await shared;
  await db.query(`truncate ${TABLES.join(", ")} cascade`);
  const sim = simulate(o);
  const faults = new Faults();
  return { ...sim, rt: new Runtime(db, sim.adapters, faults), db, pkg: buildPackage(r.program!, LOCK), faults };
}

const TABLES = ["outbox", "inbox", "evidence", "authorizations", "actions", "reservations", "budgets", "commands", "events", "runs", "packages"];

export async function closeAll(): Promise<void> {
  const db = shared;
  shared = undefined;
  if (db) await (await db).close();
}

/** Lets pending promise callbacks run, so "in flight" work reaches its next await. */
export async function flush(n = 20): Promise<void> {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

export async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Starts a run with a fixed id, so a test can resume it after a crash. */
export function start(w: World, workflow: string, runId: string, o: Omit<StartOptions, "pkg" | "workflow" | "runId" | "input"> & { input?: StartOptions["input"] } = {}) {
  return w.rt.startRun({ pkg: w.pkg, workflow, runId, input: o.input ?? ISSUE, ...o });
}

/** The ids of a run's commands of one kind, in dispatch order. */
export async function commandIds(w: World, runId: string, kind: string): Promise<string[]> {
  const rows = await w.db.query<{ command_id: string }>("select command_id from commands where run_id = $1 and kind = $2 order by command_id", [runId, kind]);
  return rows.map((r) => r.command_id);
}
