// The chained journal (spec/journal.md). Each event of a run carries the hash
// of what it says and of the event before it, so an event that is edited,
// removed or put in another place no longer links to its neighbours:
//
//   hash = digest("event", { run, seq, type, data, at, prev })
//
// `data` is the event's data in the form the database gives it back, `at` the
// time it was stored with, and `prev` the hash of the event before it, `null`
// at seq 1. A run is chained when its first event has a hash. A run begun
// before the journal was chained keeps writing events without one.

import { digest, type Value } from "./values.js";

/** What an event's hash is computed over (spec/journal.md "The event hash"). */
export interface EventLink {
  run: string;
  seq: number;
  type: string;
  data: Value;
  at: number;
  prev: string | null;
}

/** The hash of an event: the `event` domain's digest of its link. */
export function eventHash(e: EventLink): string {
  return digest("event", { run: e.run, seq: e.seq, type: e.type, data: e.data, at: e.at, prev: e.prev });
}
