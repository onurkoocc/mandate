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

/** The format of a journal anchor (spec/journal.md "Anchors"). */
export const ANCHOR_FORMAT = "mandate/journal-anchor/0.1";

/**
 * What an anchor signs: the run, the seq and hash of the state event it was written with, and that event's time.
 * The signature covers `"mandate/journal-anchor/0.1\n"` and the statement's canonical bytes, as every statement the
 * runtime's evidence key signs (`EvidenceSigner.signStatement`).
 */
export function anchorStatement(run: string, seq: number, hash: string, at: number): Value {
  return { format: ANCHOR_FORMAT, run, seq, hash, at };
}

/** Signs an anchor's statement with the runtime's evidence key. The journal holds no key: it is given this. */
export type AnchorSigner = (format: string, statement: Value) => { key_id: string; signature: string };
