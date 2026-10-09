// Rate limits (Doc 4 §8.6): how much per unit of time, kept apart from the
// budget, which is how much in total. Every run and every agent draws from
// the same buckets, which live in PostgreSQL, so workers on many machines
// share them; a bucket per agent would add up to more than a provider allows.
//
//   "model"            every model call: infer, an agent loop's turns, a review
//   "model:<tier>"     model calls of one tier
//   "tool"             an agent loop's tool calls
//
// A bucket holds up to `capacity` tokens and refills at `perSecond`. A call
// takes one token from each bucket that applies. When one is empty, the call
// is `Throttled(retry_after_ms)`: it is not a BudgetExceeded, it is not an
// attempt a supervisor counts, and its reservation is not held while it
// waits. At most `queue` calls may wait on a bucket; past that a call is
// refused outright (`queue_full`), never queued silently: back pressure.

import type { Outcome } from "./adapters.js";
import { num, type Db, type Row } from "./db.js";

export interface BucketConfig {
  capacity: number;
  /** Tokens added per second. */
  perSecond: number;
  /** How many calls may wait on the bucket at once. Default 100. */
  queue?: number;
}

export class RateLimiter {
  constructor(
    private readonly db: Db,
    readonly buckets: Record<string, BucketConfig>,
    private readonly now: () => number,
  ) {
    for (const [k, b] of Object.entries(buckets)) {
      if (!(b.capacity >= 1) || !(b.perSecond > 0)) throw new Error(`Rate limit ${k} needs a capacity of at least 1 and a positive rate.`);
    }
  }

  /** The configured buckets a command draws from. */
  keys(kind: string, tier?: string): string[] {
    const want = kind === "tool" ? ["tool"] : ["infer", "turn", "review"].includes(kind) ? ["model", ...(tier ? [`model:${tier}`] : [])] : [];
    return want.filter((k) => Object.hasOwn(this.buckets, k));
  }

  /** Takes one token from each bucket, or none: undefined when the call may go, a Throttled outcome when it may not. */
  async take(keys: string[]): Promise<Outcome | undefined> {
    if (!keys.length) return undefined;
    return this.db.tx(async (tx) => {
      const now = this.now();
      const levels: Array<{ key: string; level: number; cfg: BucketConfig }> = [];
      for (const key of [...keys].sort()) {
        const cfg = this.buckets[key]!;
        await tx.query("insert into rate_buckets (key, tokens, updated_at) values ($1, $2, $3) on conflict (key) do nothing", [key, cfg.capacity, now]);
        const [b] = await tx.query<Row>("select tokens, updated_at from rate_buckets where key = $1 for update", [key]);
        const level = Math.min(cfg.capacity, Number(b!["tokens"]) + (Math.max(0, now - num(b!["updated_at"])) / 1000) * cfg.perSecond);
        levels.push({ key, level, cfg });
      }
      const empty = levels.filter((l) => l.level < 1);
      if (empty.length) {
        const worst = empty.reduce((a, b) => ((1 - a.level) / a.cfg.perSecond >= (1 - b.level) / b.cfg.perSecond ? a : b));
        const retry = Math.ceil(((1 - worst.level) / worst.cfg.perSecond) * 1000);
        const [q] = await tx.query<Row>("select count(*) as n from commands where state = 'throttled' and error->'args'->0->>'bucket' = $1", [worst.key]);
        const full = num(q?.["n"]) >= (worst.cfg.queue ?? 100);
        return { error: { tag: "Throttled", args: [{ retry_after_ms: retry, bucket: worst.key, ...(full ? { queue_full: true } : {}) }] }, cost: {} };
      }
      for (const l of levels) await tx.query("update rate_buckets set tokens = $2, updated_at = $3 where key = $1", [l.key, l.level - 1, now]);
      return undefined;
    });
  }
}
