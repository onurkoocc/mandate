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
//
// At every state change the runtime's evidence key signs an anchor over the
// state event's hash. An export carries the events, the anchors, the manifest
// and the package; `verifyExport` checks one with nothing but the public keys.

import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { hashProgram, packageHash, type Json } from "@mandate/bridge";
import type { Db, Row, Tx } from "./db.js";
import { keyIdOf } from "./evidence.js";
import { Violation } from "./signals.js";
import { canonical, digest, isObj, type Obj, type Value } from "./values.js";

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

/**
 * The events a state change writes, `run_<state>` for each state a run can be in. Each one of a chained run is
 * anchored in the transaction that wrote it, so one without its anchor is a finding (`anchor_missing`).
 */
export const STATE_EVENTS: readonly string[] = ["run_accepted", "run_running", "run_waiting", "run_cancelling", "run_attention_required", "run_succeeded", "run_failed", "run_cancelled"];

// ── the export (spec/journal.md "The export") ───────────────────────────

export const JOURNAL_EXPORT_FORMAT = "mandate/journal-export/0.1";

export interface ExportedEvent {
  seq: number;
  type: string;
  data: Value;
  at: number;
  hash: string | null;
}

export interface ExportedAnchor {
  seq: number;
  hash: string;
  at: number;
  key_id: string;
  signature: string;
}

/**
 * A run's journal as an outsider checks it: its events and anchors, the manifest the first event names by hash,
 * and the package it names, with what its hash is computed from. No decision or evidence record: those have their
 * own signatures and their own checks (`mandate verify-decision`).
 */
export interface JournalExport {
  format: typeof JOURNAL_EXPORT_FORMAT;
  run: string;
  tenant: string;
  manifest_hash: string | null;
  manifest: Value;
  package: { hash: string; program: Value; lock: Value; modules: Value };
  events: ExportedEvent[];
  anchors: ExportedAnchor[];
  /** The key ids that signed the anchors. Advisory: the verifier trusts the keys it is given, not these. */
  keys: string[];
}

/**
 * Reads a run's journal out of the database as it is: nothing is checked here, and nothing is left out. Everything
 * is read in one transaction at REPEATABLE READ, so the export is one snapshot: an event or a state change committed
 * while it is read is in all of it or in none of it. It takes no lock, so no writer waits for it. `between` is a seam
 * for tests: it runs after the events are read and before the anchors are.
 */
export async function exportJournal(db: Db, runId: string, o: { between?: () => Promise<void> | void } = {}): Promise<JournalExport> {
  return db.tx(async (tx) => {
    // The first statement of the transaction, as PostgreSQL requires: every read after it sees one snapshot.
    await tx.query("set transaction isolation level repeatable read");
    return snapshot(tx, runId, o.between);
  });
}

async function snapshot(db: Tx, runId: string, between: (() => Promise<void> | void) | undefined): Promise<JournalExport> {
  const [run] = await db.query<Row>("select tenant, package_hash, manifest, manifest_hash from runs where run_id = $1", [runId]);
  if (!run) throw new Violation("unknown_run", `No run '${runId}'.`);
  const events = (await db.query<Row>("select seq, type, data, at, hash from events where run_id = $1 order by seq", [runId])).map(
    (r): ExportedEvent => ({ seq: Number(r["seq"]), type: String(r["type"]), data: (r["data"] ?? null) as Value, at: Number(r["at"]), hash: (r["hash"] ?? null) as string | null }),
  );
  await between?.();
  const anchors = (await db.query<Row>("select seq, hash, at, key_id, signature from journal_anchors where run_id = $1 order by seq", [runId])).map(
    (r): ExportedAnchor => ({ seq: Number(r["seq"]), hash: String(r["hash"]), at: Number(r["at"]), key_id: String(r["key_id"]), signature: String(r["signature"]) }),
  );
  // The package is the one the run began under, as its first event names it: an amendment has changed the run's row
  // since. When the database has no package of that hash, the run's own is exported, and the verifier says so.
  const first = events[0];
  const named = first?.seq === 1 && first.type === "run_accepted" && isObj(first.data) && typeof first.data["package"] === "string" ? first.data["package"] : String(run["package_hash"]);
  const select = "select package_hash, program, lock, modules from packages where package_hash = $1";
  const [pkg] = [...(await db.query<Row>(select, [named])), ...(await db.query<Row>(select, [run["package_hash"]]))];
  return {
    format: JOURNAL_EXPORT_FORMAT,
    run: runId,
    tenant: String(run["tenant"]),
    manifest_hash: (run["manifest_hash"] ?? null) as string | null,
    manifest: (run["manifest"] ?? null) as Value,
    package: { hash: String(pkg?.["package_hash"] ?? named), program: (pkg?.["program"] ?? {}) as Value, lock: (pkg?.["lock"] ?? {}) as Value, modules: (pkg?.["modules"] ?? {}) as Value },
    events,
    anchors,
    keys: [...new Set(anchors.map((a) => a.key_id))].sort(),
  };
}

// ── reading an export (spec/journal.md "Reading an export") ─────────────

/**
 * The largest export every verifier reads, in bytes of UTF-8, and the deepest nesting of arrays and objects in it,
 * the outermost object counting as one (spec/journal.md "Reading an export"). Part of the contract: a journal beyond
 * them is `unreadable` for every verifier alike, and nothing is said about it. The runtime writes such a journal as
 * any other; `mandate journal export` says when what it wrote is beyond them.
 */
export const EXPORT_LIMITS = { bytes: 64 * 1024 * 1024, depth: 256 } as const;

class Malformed extends Error {
  constructor(
    message: string,
    readonly over = false,
  ) {
    super(message);
  }
}

/**
 * Strict JSON (RFC 8259) for an export: UTF-8 without a byte order mark; no duplicate member names; no lone
 * surrogate, escaped or not; every number finite as a double; at most `EXPORT_LIMITS`. A number may have a
 * fraction or an exponent: event data holds whatever a run journaled. It is read as `JSON.parse` reads it.
 */
export function parseExportJson(input: Uint8Array | string): { ok: true; value: unknown } | { ok: false; problem: string; over: boolean } {
  let pos = 0;
  const fail = (what: string, over = false): never => {
    throw new Malformed(`${what} at offset ${pos}`, over);
  };
  try {
    let text: string;
    if (typeof input === "string") {
      if (Buffer.byteLength(input, "utf8") > EXPORT_LIMITS.bytes) fail(`an export larger than ${EXPORT_LIMITS.bytes} bytes`, true);
      text = input;
    } else {
      if (input.byteLength > EXPORT_LIMITS.bytes) fail(`an export larger than ${EXPORT_LIMITS.bytes} bytes`, true);
      try {
        text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
      } catch {
        throw new Malformed("an export that is not UTF-8");
      }
    }
    const ws = (): void => {
      for (;;) {
        const c = text.charCodeAt(pos);
        if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) pos++;
        else return;
      }
    };
    const hex4 = (): number => {
      const h = text.slice(pos, pos + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(h)) fail("an escape without four hex digits");
      pos += 4;
      return parseInt(h, 16);
    };
    const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
    const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
    const string = (): string => {
      pos++;
      let out = "";
      for (;;) {
        if (pos >= text.length) fail("an unterminated string");
        const c = text.charCodeAt(pos);
        if (c === 0x22) {
          pos++;
          return out;
        }
        if (c < 0x20) fail("a control character in a string");
        if (c === 0x5c) {
          const e = text[pos + 1];
          pos += 2;
          if (e === '"' || e === "\\" || e === "/") out += e;
          else if (e === "b") out += "\b";
          else if (e === "f") out += "\f";
          else if (e === "n") out += "\n";
          else if (e === "r") out += "\r";
          else if (e === "t") out += "\t";
          else if (e === "u") {
            const u = hex4();
            if (isHigh(u)) {
              if (text[pos] !== "\\" || text[pos + 1] !== "u") fail("a lone surrogate");
              pos += 2;
              const low = hex4();
              if (!isLow(low)) fail("a lone surrogate");
              out += String.fromCharCode(u, low);
            } else if (isLow(u)) fail("a lone surrogate");
            else out += String.fromCharCode(u);
          } else fail("an unknown escape");
          continue;
        }
        if (isHigh(c)) {
          if (!isLow(text.charCodeAt(pos + 1))) fail("a lone surrogate");
          out += text.slice(pos, pos + 2);
          pos += 2;
          continue;
        }
        if (isLow(c)) fail("a lone surrogate");
        out += text[pos];
        pos++;
      }
    };
    const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
    const value = (depth: number): unknown => {
      ws();
      const c = text[pos];
      if (c === "[" || c === "{") {
        if (depth >= EXPORT_LIMITS.depth) fail(`nesting deeper than ${EXPORT_LIMITS.depth}`, true);
        pos++;
        ws();
        if (c === "[") {
          const arr: unknown[] = [];
          if (text[pos] === "]") {
            pos++;
            return arr;
          }
          for (;;) {
            arr.push(value(depth + 1));
            ws();
            if (text[pos] === ",") pos++;
            else if (text[pos] === "]") {
              pos++;
              return arr;
            } else fail("a list without , or ]");
          }
        }
        const obj: Record<string, unknown> = {};
        if (text[pos] === "}") {
          pos++;
          return obj;
        }
        for (;;) {
          ws();
          if (text[pos] !== '"') fail("an object without a member name");
          const key = string();
          if (Object.hasOwn(obj, key)) fail(`a duplicate member ${JSON.stringify(key)}`);
          ws();
          if (text[pos] !== ":") fail("a member without :");
          pos++;
          // A name such as __proto__ is a member like any other.
          Object.defineProperty(obj, key, { value: value(depth + 1), enumerable: true, writable: true, configurable: true });
          ws();
          if (text[pos] === ",") pos++;
          else if (text[pos] === "}") {
            pos++;
            return obj;
          } else fail("an object without , or }");
        }
      }
      if (c === '"') return string();
      for (const [word, v] of [["true", true], ["false", false], ["null", null]] as const) {
        if (text.startsWith(word, pos)) {
          pos += word.length;
          return v;
        }
      }
      NUMBER.lastIndex = pos;
      const m = NUMBER.exec(text);
      if (!m) return fail("no value");
      pos += m[0].length;
      const n = Number(m[0]);
      if (!Number.isFinite(n)) fail("a number beyond a double");
      return n;
    };
    const v = value(0);
    ws();
    if (pos !== text.length) fail("content after the value");
    return { ok: true, value: v };
  } catch (e) {
    if (e instanceof Malformed) return { ok: false, problem: e.message, over: e.over };
    throw e;
  }
}

/** Whether `v` is an object with exactly these members. */
function closed(v: unknown, keys: readonly string[]): v is Obj {
  return isObj(v as Value) && Object.keys(v as Obj).length === keys.length && keys.every((k) => Object.hasOwn(v as Obj, k));
}

const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;
const isStr = (v: unknown): v is string => typeof v === "string";

/** An export read and held to its shape (spec/journal.md "The export"), or the first thing wrong with it. */
export function readExport(input: Uint8Array | string): { ok: true; value: JournalExport } | { ok: false; problem: string; over: boolean } {
  const parsed = parseExportJson(input);
  if (!parsed.ok) return parsed;
  const x = parsed.value;
  const bad = (problem: string) => ({ ok: false as const, problem, over: false });
  if (!closed(x, ["format", "run", "tenant", "manifest_hash", "manifest", "package", "events", "anchors", "keys"])) return bad(`the export does not have exactly the members of ${JOURNAL_EXPORT_FORMAT}`);
  if (x["format"] !== JOURNAL_EXPORT_FORMAT) return bad(`the format is not ${JOURNAL_EXPORT_FORMAT}`);
  if (!isStr(x["run"]) || x["run"] === "" || !isStr(x["tenant"])) return bad("run is not a run id, or tenant is not a string");
  if (!(x["manifest"] === null || isObj(x["manifest"]!)) || !(x["manifest_hash"] === null || isStr(x["manifest_hash"]))) return bad("manifest is not an object or null, or manifest_hash is not a string or null");
  const p = x["package"];
  if (!closed(p, ["hash", "program", "lock", "modules"]) || !isStr(p["hash"]) || !isObj(p["program"]!) || !isObj(p["lock"]!) || !isObj(p["modules"]!)) return bad("package is not { hash, program, lock, modules }");
  const events = x["events"];
  if (!Array.isArray(events) || !events.length) return bad("events is not a list of at least one event");
  for (const [i, e] of events.entries()) {
    if (!closed(e, ["seq", "type", "data", "at", "hash"]) || !isSeq(e["seq"]) || !isStr(e["type"]) || !Number.isSafeInteger(e["at"]) || !(e["hash"] === null || isStr(e["hash"]))) {
      return bad(`event ${i} is not { seq, type, data, at, hash }`);
    }
  }
  const anchors = x["anchors"];
  if (!Array.isArray(anchors)) return bad("anchors is not a list");
  for (const [i, a] of anchors.entries()) {
    if (!closed(a, ["seq", "hash", "at", "key_id", "signature"]) || !isSeq(a["seq"]) || !isStr(a["hash"]) || !Number.isSafeInteger(a["at"]) || !isStr(a["key_id"]) || !isStr(a["signature"])) {
      return bad(`anchor ${i} is not { seq, hash, at, key_id, signature }`);
    }
    if (i > 0 && (a["seq"] as number) <= ((anchors[i - 1] as Obj)["seq"] as number)) return bad(`anchor ${i} does not come after the one before it`);
  }
  if (!Array.isArray(x["keys"]) || !x["keys"].every(isStr)) return bad("keys is not a list of key ids");
  return { ok: true, value: x as unknown as JournalExport };
}

// ── verification (spec/journal.md "Verification") ──────────────────────

export const JOURNAL_REPORT_FORMAT = "mandate/journal-verification/0.1";

export type FindingCode =
  | "malformed_export"
  | "export_over_limit"
  | "seq_gap"
  | "hash_missing"
  | "chain_broken"
  | "manifest_mismatch"
  | "package_mismatch"
  | "anchor_unknown_key"
  | "anchor_signature_invalid"
  | "anchor_beyond_end"
  | "anchor_mismatch"
  | "anchor_missing"
  | "unanchored_tail";

export interface JournalFinding {
  code: FindingCode;
  seq?: number;
}

/**
 * What a verifier says about a run's journal (spec/journal.md "The report"). `verified`: the chain holds from seq 1,
 * every state event is anchored by a key given, and signatures cover the events through `anchored_through`; the
 * `unanchored` events after it are covered by none. `broken`: any finding but `unanchored_tail`. `unchained`: no
 * event has a hash and nothing is anchored, as for a run begun before the journal was chained; it says nothing
 * either way. `unreadable`: the export could not be read (`malformed_export`) or is beyond what every verifier reads
 * (`export_over_limit`); nothing is said about the journal.
 */
export interface JournalReport {
  format: typeof JOURNAL_REPORT_FORMAT;
  run: string | null;
  status: "verified" | "broken" | "unchained" | "unreadable";
  events: number;
  last_seq: number | null;
  anchored_through: number | null;
  unanchored: number;
  signed_by: string[];
  findings: JournalFinding[];
}

const SIGNATURE = /^ed25519:[A-Za-z0-9+/]{86}==$/;

/** Whether `signature` is `ed25519:` and the canonical base64 of a signature by `key` over the anchor's statement. */
function anchorSigned(key: KeyObject, run: string, a: ExportedAnchor): boolean {
  if (!SIGNATURE.test(a.signature)) return false;
  const b64 = a.signature.slice("ed25519:".length);
  const sig = Buffer.from(b64, "base64");
  if (sig.length !== 64 || sig.toString("base64") !== b64) return false;
  try {
    return verify(null, Buffer.from(`${ANCHOR_FORMAT}\n${canonical(anchorStatement(run, a.seq, a.hash, a.at))}`, "utf8"), key, sig);
  } catch {
    return false;
  }
}

/** The ed25519 public keys in PEM text: every `PUBLIC KEY` block in it, in order. Throws on a block that is not one. */
export function publicKeysIn(pem: string): KeyObject[] {
  const blocks = pem.match(/-----BEGIN PUBLIC KEY-----[^-]*-----END PUBLIC KEY-----/g) ?? [];
  return blocks.map((b) => {
    const key = createPublicKey(b);
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`a journal key is ed25519, not ${key.asymmetricKeyType}`);
    return key;
  });
}

/**
 * Verifies a run's journal from its export and the public keys its anchors may be signed with (spec/journal.md
 * "Verification"). It reads nothing else: no database, no configuration. Everything in the export is untrusted.
 */
export function verifyExport(input: Uint8Array | string, keys: ReadonlyArray<KeyObject | string>): JournalReport {
  // The keys are the caller's: one that is not an ed25519 key is a wrong argument, not a finding about the journal.
  const byId = new Map<string, KeyObject>();
  for (const k of keys) {
    const given = typeof k === "string" ? createPublicKey(k) : k;
    const key = given.type === "private" ? createPublicKey(given) : given;
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") throw new TypeError(`A journal key is an ed25519 public key, not ${key.asymmetricKeyType ?? key.type}.`);
    byId.set(keyIdOf(key), key);
  }
  const report = (r: Omit<JournalReport, "format">): JournalReport => ({ format: JOURNAL_REPORT_FORMAT, ...r });
  const read = readExport(input);
  if (!read.ok) return report({ run: null, status: "unreadable", events: 0, last_seq: null, anchored_through: null, unanchored: 0, signed_by: [], findings: [{ code: read.over ? "export_over_limit" : "malformed_export" }] });
  const x = read.value;
  const { run, events, anchors } = x;
  const last = events[events.length - 1]!.seq;
  // A run begun before the chain: no event has a hash and nothing is anchored. Anything else is checked as chained.
  if (events.every((e) => e.hash === null) && !anchors.length) {
    return report({ run, status: "unchained", events: events.length, last_seq: last, anchored_through: null, unanchored: events.length, signed_by: [], findings: [] });
  }
  const findings: JournalFinding[] = [];
  // 1. The events are seq 1, 2, 3, … in order: the first place one is not is a gap (a removed or moved event).
  const gap = events.findIndex((e, i) => e.seq !== i + 1);
  if (gap >= 0) findings.push({ code: "seq_gap", seq: gap + 1 });
  // 2. Each event's hash is that of its contents and of the hash before it in the export.
  let prev: string | null = null;
  for (const e of events) {
    if (e.hash === null) findings.push({ code: "hash_missing", seq: e.seq });
    else if (e.hash !== eventHash({ run, seq: e.seq, type: e.type, data: e.data, at: e.at, prev })) findings.push({ code: "chain_broken", seq: e.seq });
    prev = e.hash;
  }
  // 3. The first event names the manifest and the package by hash; the export's are those.
  const first = events[0]!;
  const accepted = first.seq === 1 && first.type === "run_accepted" && isObj(first.data) ? first.data : undefined;
  const m = x.manifest;
  const named = (v: Value | undefined): v is string => typeof v === "string";
  if (
    !accepted ||
    !isObj(m) ||
    !named(accepted["manifest"]) ||
    digest("run", m) !== accepted["manifest"] ||
    x.manifest_hash !== accepted["manifest"] ||
    !named(m["tenant"]) ||
    m["tenant"] !== x.tenant ||
    !named(m["package"]) ||
    !named(accepted["package"]) ||
    m["package"] !== accepted["package"]
  ) {
    findings.push({ code: "manifest_mismatch" });
  }
  if (!accepted || !packageHolds(x.package, accepted["package"])) findings.push({ code: "package_mismatch" });
  // 4. Each anchor: a key given, a signature by it over the statement, and the event it names, as it is.
  const max = events.reduce((n, e) => Math.max(n, e.seq), 0);
  // The event an anchor names is the first one with its seq in the export's order.
  const bySeq = new Map<number, ExportedEvent>();
  for (const e of events) if (!bySeq.has(e.seq)) bySeq.set(e.seq, e);
  let through: number | null = null;
  const signers = new Set<string>();
  for (const a of anchors) {
    const key = byId.get(a.key_id);
    const signed = key !== undefined && anchorSigned(key, run, a);
    if (!key) findings.push({ code: "anchor_unknown_key", seq: a.seq });
    else if (!signed) findings.push({ code: "anchor_signature_invalid", seq: a.seq });
    const e = bySeq.get(a.seq);
    const matches = e !== undefined && e.hash === a.hash && e.at === a.at;
    if (a.seq > max) findings.push({ code: "anchor_beyond_end", seq: a.seq });
    else if (!matches) findings.push({ code: "anchor_mismatch", seq: a.seq });
    if (signed && matches) {
      through = a.seq;
      signers.add(a.key_id);
    }
  }
  // 5. Every state event of a chained run was anchored in the transaction that wrote it.
  const anchored = new Set(anchors.map((a) => a.seq));
  for (const e of events) if (STATE_EVENTS.includes(e.type) && !anchored.has(e.seq)) findings.push({ code: "anchor_missing", seq: e.seq });
  // 6. What no signature covers: the events after the last anchor that holds. Normal for a run that goes on, and
  //    never part of what "verified" says.
  const after = events.filter((e) => e.seq > (through ?? 0));
  if (after.length) findings.push({ code: "unanchored_tail", seq: after[0]!.seq });
  const status = findings.some((f) => f.code !== "unanchored_tail") ? "broken" : "verified";
  return report({ run, status, events: events.length, last_seq: last, anchored_through: through, unanchored: after.length, signed_by: [...signers].sort(), findings });
}

/** Whether the package hashes to `named`: its program and lock (`packageHash`), and each module to its pin in the lock. */
function packageHolds(p: JournalExport["package"], named: Value | undefined): boolean {
  try {
    if (typeof named !== "string" || p.hash !== named || packageHash(hashProgram(p.program as Json).program, p.lock as object) !== named) return false;
    const lock = p.lock as Obj;
    const pins = isObj(lock["modules"] ?? null) ? (lock["modules"] as Obj) : {};
    return Object.entries(p.modules as Obj).every(([name, m]) => isObj(m) && m["module"] === name && Object.hasOwn(pins, name) && hashProgram(m as Json).program === pins[name]);
  } catch {
    // A program or lock the IR's canonical form cannot hold (a fraction, an unsafe integer) hashes to no package.
    return false;
  }
}
