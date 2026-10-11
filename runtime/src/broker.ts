// The read broker (design doc 9 §5.1, K43; BACKLOG item 34, B6). Agents
// never touch production: no network, no credential. A workflow reads
// through the broker, in the control plane, and only what the system model
// declares:
//
//   - the query text is the environment's, in the program's IR, so it was
//     checked and reviewed with the program; values arrive only as its
//     typed parameters, bound, never spliced (model output may be a value,
//     never query text);
//   - SQL runs in a read-only transaction with a statement timeout, through a
//     read-only login that only the broker holds;
//   - only the row type's declared fields come back, and a field of a class
//     above what the caller may receive is masked here, before anything sees
//     it (a class is never lowered, §5.5);
//   - each read is a journaled command with its `as_of`, so replay never asks
//     the broker again (INV-09).

import pg from "pg";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DATA_CLASSES, type DataClass, type Expr } from "@mandate/compiler";
import type { Outcome, ReadBroker, ReadRequest } from "./adapters.js";
import { digest, isObj, type Obj, type Value } from "./values.js";

export const BROKER_ID = "mandate-read-broker@0.3";

/** Where an environment's component keeps the data a read asks for. */
export interface ReadSourceConfig {
  /** A PostgreSQL URL with a read-only login, for `sql` reads. */
  url?: string;
  /** A directory of JSON-lines log files (`<component>.jsonl`, or every `*.jsonl`), for `logs` reads. */
  logs?: string;
}

/** Runs one parameterized SQL statement in a read-only transaction; tests pass PGlite. */
export interface SqlRunner {
  query(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>>;
}

export class DeclaredReads implements ReadBroker {
  constructor(
    /** By `<environment>/<component>`. */
    private readonly sources: Record<string, ReadSourceConfig>,
    private readonly o: { clock?: () => number; sql?: (url: string) => SqlRunner; statementTimeoutMs?: number } = {},
  ) {}

  describe(): { id: string; digest: string } {
    return { id: BROKER_ID, digest: digest("request", { broker: BROKER_ID, sources: Object.keys(this.sources).sort() }) };
  }

  async query(req: ReadRequest): Promise<Outcome> {
    const src = this.sources[`${req.environment}/${req.from}`];
    const asOf = (this.o.clock ?? Date.now)();
    let raw: Array<Record<string, unknown>>;
    try {
      if ("sql" in req.query) {
        if (!src?.url) return refused(`no database is configured for ${req.environment}/${req.from}`);
        const { text, values } = bind(req.query.sql, req.params);
        const runner = (this.o.sql ?? pgRunner(this.o.statementTimeoutMs ?? 5000))(src.url);
        raw = await runner.query(`select * from (${text}) as declared limit ${req.maxRows + 1}`, values);
      } else {
        if (!src?.logs) return refused(`no logs are configured for ${req.environment}/${req.from}`);
        raw = logRows(src.logs, req.from, req.query.logs as unknown as Expr, req.params, req.maxRows + 1);
      }
    } catch (e) {
      return refused((e as Error).message);
    }
    const truncated = raw.length > req.maxRows;
    const masked = Object.entries(req.fields).filter(([, c]) => rank(c) > rank(req.maxClass)).map(([f]) => f).sort();
    const rows = raw.slice(0, req.maxRows).map((r) => {
      const out: Obj = {};
      // Only the declared fields leave the broker; a field above the caller's class leaves masked.
      for (const [f, c] of Object.entries(req.fields)) out[f] = masked.includes(f) ? { $masked: c } : toValue(r[f]);
      return out;
    });
    return { ok: { rows, masked, as_of: asOf, truncated, row_count: rows.length }, cost: {} };
  }
}

const rank = (c: DataClass): number => DATA_CLASSES.indexOf(c);

function refused(why: string): Outcome {
  return { error: { tag: "Rejected", args: [{ reason: "read_refused", detail: why }] }, cost: {} };
}

/** `:name` placeholders to `$n`, with the parameters' values in order; a placeholder without a value is refused. */
export function bind(sql: string, params: Record<string, Value>): { text: string; values: unknown[] } {
  const order: string[] = [];
  const text = sql.trim().replace(/;\s*$/, "").replace(/(?<![:\w]):([A-Za-z_]\w*)/g, (_m, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`no value for :${name}`);
    let i = order.indexOf(name);
    if (i < 0) i = order.push(name) - 1;
    return `$${i + 1}`;
  });
  return { text, values: order.map((n) => params[n]) };
}

/** PostgreSQL's type id of `date`. */
const DATE_OID = 1082;

function pgRunner(timeoutMs: number): (url: string) => SqlRunner {
  return (url) => ({
    async query(sql, params) {
      // A `date` is a calendar day, not an instant: kept as its text (YYYY-MM-DD). Parsed, it would become the host's
      // local midnight and read as the day before wherever the host is east of UTC.
      const client = new pg.Client({ connectionString: url, types: { getTypeParser: (oid: number, format?: string) => (oid === DATE_OID ? (v: string) => v : pg.types.getTypeParser(oid, format as "text")) } });
      await client.connect();
      try {
        await client.query("begin transaction read only");
        await client.query(`set local statement_timeout = ${Math.floor(timeoutMs)}`);
        const r = await client.query(sql, params);
        return r.rows as Array<Record<string, unknown>>;
      } finally {
        await client.query("rollback").catch(() => undefined);
        await client.end();
      }
    },
  });
}

function toValue(v: unknown): Value {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "object") return JSON.parse(JSON.stringify(v)) as Value;
  return v as Value;
}

/** The log lines of `component` in `dir` that the filter keeps, up to `limit`. */
function logRows(dir: string, component: string, filter: Expr, params: Record<string, Value>, limit: number): Array<Record<string, unknown>> {
  const own = join(dir, `${component}.jsonl`);
  const files = existsSync(own) ? [own] : readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => join(dir, f));
  const out: Array<Record<string, unknown>> = [];
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: unknown;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObj(row as Value)) continue;
      if (evaluate(filter, row as Obj, params) === true) out.push(row as Record<string, unknown>);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

/**
 * The log filter, evaluated over one line: comparisons, `and`, `or`, `not`,
 * literals, the line's fields and the read's parameters. Nothing else runs.
 */
export function evaluate(e: Expr, row: Obj, params: Record<string, Value>): Value {
  switch (e.op) {
    case "bool":
    case "int":
    case "text":
      return e.value;
    case "dec":
      return Number(e.value);
    case "var":
      return Object.hasOwn(params, e.name) ? params[e.name]! : Object.hasOwn(row, e.name) ? row[e.name]! : null;
    case "unary":
      return e.uop === "not" ? evaluate(e.of, row, params) !== true : -Number(evaluate(e.of, row, params));
    case "binary": {
      if (e.bop === "and") return evaluate(e.left, row, params) === true && evaluate(e.right, row, params) === true;
      if (e.bop === "or") return evaluate(e.left, row, params) === true || evaluate(e.right, row, params) === true;
      const l = evaluate(e.left, row, params);
      const r = evaluate(e.right, row, params);
      if (l === null || r === null) return e.bop === "!=" ? l !== r : e.bop === "==" ? l === r : false;
      switch (e.bop) {
        case "==":
          return l === r;
        case "!=":
          return l !== r;
        case "<":
          return (l as number | string) < (r as number | string);
        case "<=":
          return (l as number | string) <= (r as number | string);
        case ">":
          return (l as number | string) > (r as number | string);
        case ">=":
          return (l as number | string) >= (r as number | string);
      }
    }
  }
  throw new Error(`a log filter cannot use ${e.op}`);
}

/** Sample rows for `design` runs, by `<environment>.<read>`: what the design is tried against, never production. */
export class SampleReads implements ReadBroker {
  constructor(private readonly samples: Record<string, Value[]>) {}
  describe(): { id: string; digest: string } {
    return { id: "mandate-sample-reads@0.3", digest: digest("request", { samples: this.samples }) };
  }
  async query(req: ReadRequest): Promise<Outcome> {
    const rows = this.samples[`${req.environment}.${req.read}`];
    if (!rows) return refused(`no sample rows for ${req.environment}.${req.read}`);
    const masked = Object.entries(req.fields).filter(([, c]) => rank(c) > rank(req.maxClass)).map(([f]) => f).sort();
    const shown = rows.slice(0, req.maxRows).map((r) => Object.fromEntries(Object.keys(req.fields).map((f) => [f, masked.includes(f) ? { $masked: req.fields[f]! } : isObj(r) ? (r[f] ?? null) : null])));
    return { ok: { rows: shown, masked, as_of: 0, truncated: rows.length > req.maxRows, row_count: shown.length, sample: true }, cost: {} };
  }
}
