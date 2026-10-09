// PostgreSQL access (Doc 4 §16.1). The journal, budget ledger, actions and
// authorizations live in PostgreSQL, which is the authority for them: every
// decision that must be atomic (reserve + dispatch record, consume an
// authorization, cancel vs dispatch) is one transaction that first locks the
// run's row, so writers of the same run are serialized.
//
// Two drivers share one interface: node-postgres for a server (production,
// and CI against a real PostgreSQL), and PGlite, PostgreSQL compiled to
// WebAssembly, for in-process tests and local runs without a server.

import { PGlite } from "@electric-sql/pglite";
import pg from "pg";

export type Row = Record<string, unknown>;

export interface Tx {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Tx {
  /** Runs `fn` in one transaction; any throw rolls it back. */
  tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const SCHEMA = `
create table if not exists packages (
  package_hash text primary key,
  program jsonb not null,
  lock jsonb not null
);
create table if not exists runs (
  run_id text primary key,
  tenant text not null,
  package_hash text not null references packages(package_hash),
  workflow text not null,
  input jsonb not null,
  policy jsonb not null,
  state text not null,
  revision integer not null default 0,
  fence integer not null default 0,
  cancel_requested boolean not null default false,
  waiting jsonb,
  attention jsonb,
  result jsonb,
  error jsonb,
  summary jsonb,
  created_at bigint not null,
  updated_at bigint not null
);
create table if not exists events (
  run_id text not null references runs(run_id),
  seq integer not null,
  type text not null,
  data jsonb not null,
  at bigint not null,
  primary key (run_id, seq)
);
create table if not exists commands (
  run_id text not null references runs(run_id),
  command_id text not null,
  kind text not null,
  state text not null,
  fence integer not null,
  request_digest text not null,
  label text,
  result jsonb,
  error jsonb,
  cost jsonb,
  payload_purged boolean not null default false,
  primary key (run_id, command_id)
);
create table if not exists budgets (
  run_id text not null references runs(run_id),
  dimension text not null,
  limit_value bigint not null,
  settled bigint not null default 0,
  primary key (run_id, dimension)
);
create table if not exists reservations (
  run_id text not null,
  command_id text not null,
  dimension text not null,
  amount bigint not null,
  state text not null,
  primary key (run_id, command_id, dimension)
);
create table if not exists actions (
  operation_key text primary key,
  run_id text not null references runs(run_id),
  command_id text not null,
  effect text not null,
  action_digest text not null,
  params jsonb not null,
  retry_class text not null,
  state text not null,
  receipt jsonb,
  detail jsonb
);
create table if not exists authorizations (
  authorization_id text primary key,
  run_id text not null references runs(run_id),
  action_digest text not null,
  decided_by text not null,
  expires_at bigint,
  consumed_by text unique
);
create table if not exists evidence (
  evidence_id text primary key,
  run_id text not null references runs(run_id),
  contract text not null,
  criterion text not null,
  method text not null,
  passed boolean not null,
  detail jsonb
);
create table if not exists inbox (
  tenant text not null,
  sender text not null,
  message_id text not null,
  payload_digest text not null,
  received_at bigint not null,
  primary key (tenant, sender, message_id)
);
create table if not exists outbox (
  operation_key text primary key references actions(operation_key),
  run_id text not null,
  state text not null,
  attempts integer not null default 0
);
`;

/** Opens PostgreSQL at `url`, or an in-process PGlite database when `url` is absent. */
/**
 * A database: PostgreSQL for a `postgresql://` URL, PGlite in a directory for
 * `pglite:<dir>` (it outlives the process, so the control CLI can keep a run
 * between calls), and in-process PGlite without a URL.
 */
export async function openDb(url?: string, schema?: string): Promise<Db> {
  const db = url?.startsWith("pglite:") ? pgliteDb(url.slice("pglite:".length)) : url ? pgDb(url, schema) : pgliteDb();
  if (schema && url) await db.query(`create schema if not exists ${ident(schema)}`);
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}

function ident(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`Invalid schema name '${s}'.`);
  return s;
}

function pgliteDb(dataDir?: string): Db {
  const lite = dataDir ? new PGlite(dataDir) : new PGlite();
  const wrap = (q: Pick<PGlite, "query">): Tx => ({
    async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await q.query<T>(sql, params)).rows;
    },
  });
  return {
    ...wrap(lite),
    tx: (fn) => lite.transaction((t) => fn(wrap(t))),
    close: () => lite.close(),
  };
}

function pgDb(url: string, schema?: string): Db {
  const pool = new pg.Pool({ connectionString: url, ...(schema ? { options: `-c search_path=${ident(schema)}` } : {}) });
  const wrap = (c: pg.Pool | pg.PoolClient): Tx => ({
    async query<T extends Row>(sql: string, params: unknown[] = []): Promise<T[]> {
      return (await c.query(sql, params)).rows as T[];
    },
  });
  return {
    ...wrap(pool),
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const out = await fn(wrap(client));
        await client.query("commit");
        return out;
      } catch (e) {
        await client.query("rollback").catch(() => undefined);
        throw e;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

/** PostgreSQL returns bigint as a string (node-postgres) or a bigint (PGlite). */
export function num(v: unknown): number {
  return v === null || v === undefined ? 0 : Number(v);
}
