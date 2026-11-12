import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check, type Modules } from "@mandate/compiler";
import { build } from "esbuild";
import { expect } from "vitest";
import { ISSUE } from "./programs.js";
import type { Clock, ModelAdapter } from "../src/adapters.js";
import { openDb, type Db } from "../src/db.js";
import { Faults } from "../src/faults.js";
import { buildPackage, Runtime, type Lock, type Package, type RuntimeOptions, type StartOptions } from "../src/runtime.js";
import { simulate, type Sim, type SimAgents, type SimModel, type SimReads, type SimTool, type SimVerifier } from "../src/sim.js";
import { WorkerChecker } from "../src/plan.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

/**
 * The checker of a lead's sub-programs, as the runtime uses it: the compiler in a worker thread. A worker thread
 * runs JavaScript, so its entry point is bundled first, once for a test file; `entry` names another worker, for a
 * test of a check that never ends. The compiler reads its schemas from beside its own files, so each of its files
 * keeps its own address in the bundle.
 */
export async function planChecker(entry = "../src/plan-worker.ts", maxMb?: number): Promise<WorkerChecker> {
  const out = here("./.build");
  mkdirSync(out, { recursive: true });
  const outfile = join(out, `plan-worker-${process.pid}-${randomUUID().slice(0, 8)}.mjs`);
  await build({
    entryPoints: [here(entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@mandate/compiler": here("../../compiler/src/index.ts") },
    external: ["ajv", "ajv/*", "ajv-formats"],
    plugins: [
      {
        name: "own-address",
        setup(b) {
          b.onLoad({ filter: /[\\/]compiler[\\/]src[\\/].*\.ts$/ }, (a) => ({ contents: readFileSync(a.path, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(a.path).href)), loader: "ts" }));
        },
      },
    ],
    logLevel: "error",
  });
  return new WorkerChecker(outfile, maxMb);
}

/** Imported domain modules are pinned in every test package (S09). */
export const LOCK = { modules: { "company.domain": "sha256:0f1e" } };

/**
 * How the programs written before 0.4 take a person's decision: on the caller's word for who made it (`by`). A
 * runtime takes signed decisions unless it is told this (spec/envelope.md "Unsigned mode"), so every runtime these
 * tests build for an earlier program says it. Signed decisions have their own tests (decisions.test.ts).
 */
export const UNSIGNED = { decisions: { mode: "unsigned" } } as const satisfies RuntimeOptions;

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
export async function world(
  src: string,
  o: { tools?: SimTool[]; agents?: SimAgents; model?: SimModel; verifier?: SimVerifier; reads?: SimReads; clock?: Clock; lock?: Lock; realModel?: ModelAdapter; modules?: Modules; decisions?: RuntimeOptions["decisions"]; plan?: RuntimeOptions["plan"] } = {},
): Promise<World> {
  const r = check(src, "mdt", o.modules ? { modules: o.modules } : {});
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  const url = process.env["MANDATE_TEST_DATABASE_URL"];
  shared ??= openDb(url, url ? `t_${randomUUID().replaceAll("-", "")}` : undefined);
  const db = await shared;
  await db.query(`truncate ${TABLES.join(", ")} cascade`);
  const sim = simulate(o);
  if (o.realModel) sim.adapters.model = o.realModel;
  const faults = new Faults();
  return { ...sim, rt: new Runtime(db, sim.adapters, faults, undefined, { decisions: o.decisions ?? UNSIGNED.decisions, ...(o.plan ? { plan: o.plan } : {}) }), db, pkg: buildPackage(r.program!, o.lock ?? LOCK, o.modules), faults };
}

const TABLES = ["decisions", "changesets", "workspace_claims", "rate_buckets", "artifacts", "outbox", "inbox", "evidence", "authorizations", "actions", "reservations", "budgets", "commands", "events", "runs", "packages"];

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
