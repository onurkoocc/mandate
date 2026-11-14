// Signed decisions (0.4; spec/envelope.md "Signed decisions"). Every message
// by which a person changes a run is a decision record that the person signs
// with their own ed25519 key:
//
//   {
//     "format": "mandate/decision/0.1",
//     "kind": "approve",
//     "package": "sha256:…", "run": "run_7c…", "revision": 41,
//     "command": "/defs/FixBug/body/6/value",
//     "subject": "sha256:…",
//     "role": "code_owner", "member": "alice", "key": "sha256:3f1c…",
//     "payload": "sha256:…",
//     "at": "2026-11-10T14:02:11Z"
//   }
//
// The signature covers "mandate/decision/0.1\n" followed by the record's JCS
// bytes, and is written `ed25519:<base64>`. The record's digest is the
// SHA-256 of the same bytes, so whoever holds the record, the signature and
// the public key can check both with nothing of Mandate's.
//
// A record is a decision only when its signature verifies under a key the
// package's lock lists under the member it names, and that member holds the
// role the wait asks (INV-16). This file holds the record, the keys and that
// rule; runtime.ts applies it where a decision arrives.

import { createPublicKey, type KeyObject } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Lock } from "@mandate/bridge";
import { EvidenceSigner, keyIdOf, TrustedKeys, type EvidenceRecord } from "./evidence.js";
import { Violation } from "./signals.js";
import { digest, isObj, type Value } from "./values.js";

export const DECISION_FORMAT = "mandate/decision/0.1";

export const DECISION_KINDS = ["approve", "decline", "answer", "raise_limits", "reconcile", "envelope", "amend", "cancel"] as const;
export type DecisionKind = (typeof DECISION_KINDS)[number];

export interface DecisionRecord {
  format: typeof DECISION_FORMAT;
  kind: DecisionKind;
  /** The package the decision is about; for a run, the run's package. */
  package: string;
  run?: string;
  /** The run revision the person decided on. */
  revision?: number;
  /** The wait the decision answers, or the command of the action it reconciles. */
  command?: string;
  /** The digest the wait shows (see `Shown`). */
  subject: string;
  /** The role the member decides in; absent when the wait asks no role. */
  role?: string;
  member: string;
  /** The id of the key that signs: the SHA-256 of its public key. */
  key: string;
  /** The digest of the answer, the new limits or the reconciliation; absent for an approval or a decline. */
  payload?: string;
  /** When the person signed, RFC 3339 in UTC. */
  at: string;
}

/** A decision record with its signature, `ed25519:<base64>`: what a person sends and what the runtime stores. */
export interface SignedDecision {
  record: DecisionRecord;
  signature: string;
}

/** Why a decision is refused (spec/envelope.md, event `decision_refused`). */
export type RefusalReason = "invalid_signature" | "unknown_key" | "not_in_role" | "same_member" | "stale_revision" | "subject_mismatch";

/**
 * What a run shows to whoever decides on it now. A decision record repeats
 * these fields, so a signature is for this package, this run at this
 * revision, this wait and this subject, and for nothing else.
 *
 * `subject` is the digest the wait shows: a criterion's `subject_digest`, an
 * action digest, a change set's digest, for a question the digest of the
 * question as it was recorded, and for a decision about the run itself (a
 * raise of its limits, a cancel) the package hash.
 */
export interface Shown {
  package: string;
  run: string;
  revision: number;
  command?: string;
  subject: string;
  /** The role the wait asks. Without one, any member the lock lists may decide. */
  role?: string;
}

/**
 * What a package shows to whoever approves its envelope (spec/envelope.md
 * "Approving an envelope"): the package hash, as the package and as the
 * subject, and the envelope's `owner` role. The approval is about no run,
 * so it names no run, revision or command.
 */
export interface ShownPackage {
  package: string;
  subject: string;
  role: string;
}

/** What the approval of package `hash`'s envelope must name, for a workflow owned by `owner`. */
export function shownPackage(hash: string, owner: string): ShownPackage {
  return { package: hash, subject: hash, role: owner };
}

/**
 * The record for a decision of `kind` on what `shown` shows, signed with a
 * member's key. An envelope's approval is signed on a `ShownPackage`.
 */
export function signDecision(key: EvidenceSigner, shown: Shown | ShownPackage, d: { kind: DecisionKind; member: string; payload?: string; at: Date | string }): SignedDecision {
  const record: DecisionRecord = {
    format: DECISION_FORMAT,
    kind: d.kind,
    package: shown.package,
    ...("run" in shown ? { run: shown.run, revision: shown.revision } : {}),
    ...("command" in shown && shown.command !== undefined ? { command: shown.command } : {}),
    subject: shown.subject,
    ...(shown.role !== undefined ? { role: shown.role } : {}),
    member: d.member,
    key: key.keyId,
    ...(d.payload !== undefined ? { payload: d.payload } : {}),
    at: typeof d.at === "string" ? d.at : d.at.toISOString().replace(/\.\d{3}Z$/, "Z"),
  };
  return { record, signature: key.signStatement(DECISION_FORMAT, record as unknown as Value).signature };
}

/** A decision record's digest: the SHA-256 of the bytes its signature covers. */
export function decisionId(record: DecisionRecord): string {
  return digest("decision", record as unknown as Value);
}

/** Digests a decision record carries as `payload`. */
export const payloadOf = {
  answer: (value: Value): string => digest("request", value),
  /** The new limits by dimension, as the `limits_raised` event records them. */
  limits: (dims: Record<string, number>): string => digest("request", dims),
  reconcile: (operationKey: string): string => digest("request", { reconcile: operationKey }),
};

const FIELDS = new Set(["format", "kind", "package", "run", "revision", "command", "subject", "role", "member", "key", "payload", "at"]);

/** Whether `v` has the shape of a signed decision: the fields of the format and no others. */
export function isSignedDecision(v: unknown): v is SignedDecision {
  if (!isObj(v as Value) || typeof (v as SignedDecision).signature !== "string") return false;
  if (Object.keys(v as object).some((k) => k !== "record" && k !== "signature")) return false;
  const r = (v as SignedDecision).record as unknown as Record<string, unknown> | undefined;
  if (!r || typeof r !== "object" || Array.isArray(r)) return false;
  if (Object.keys(r).some((k) => !FIELDS.has(k))) return false;
  const text = (k: string, optional = false): boolean => (r[k] === undefined ? optional : typeof r[k] === "string" && r[k] !== "");
  return (
    r["format"] === DECISION_FORMAT &&
    (DECISION_KINDS as readonly unknown[]).includes(r["kind"]) &&
    text("package") &&
    text("run", true) &&
    (r["revision"] === undefined || Number.isSafeInteger(r["revision"])) &&
    text("command", true) &&
    text("subject") &&
    text("role", true) &&
    text("member") &&
    text("key") &&
    text("payload", true) &&
    text("at")
  );
}

/** Whether `signed` carries a valid signature of its record by the key the record names, which must be one of `keys`. */
export function signatureHolds(signed: SignedDecision, keys: TrustedKeys): boolean {
  return keys.verifyStatement(DECISION_FORMAT, signed.record as unknown as Value, { key_id: signed.record.key, signature: signed.signature });
}

/** The member the lock lists `key` under. The lock allows one (E0140). */
export function memberOf(lock: Lock, key: string): string | undefined {
  for (const [member, m] of Object.entries(lock.members ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (m.keys.includes(key)) return member;
  }
  return undefined;
}

function own<T>(o: Record<string, T> | undefined, k: string): T | undefined {
  return o !== undefined && Object.hasOwn(o, k) ? o[k] : undefined;
}

export interface Refusal {
  reason: RefusalReason;
  message: string;
}

/**
 * A decision the runtime refused (INV-16). Its code is `invalid_decision`,
 * with the reason first in the message; a decision on another revision keeps
 * the code it had before 0.4, `stale_revision`.
 */
export class InvalidDecision extends Violation {
  constructor(
    readonly reason: RefusalReason,
    detail: string,
  ) {
    super(reason === "stale_revision" ? "stale_revision" : "invalid_decision", reason === "stale_revision" ? detail : `${reason}: ${detail}`);
  }
}

/**
 * Rule 1 of acceptance and the first half of rule 2: the record is a
 * decision record, its signature verifies under the key it names, and the
 * lock lists that key under the member it names. Returns why not.
 */
export function signerRefusal(signed: unknown, keys: TrustedKeys, lock: Lock): Refusal | undefined {
  if (!isSignedDecision(signed)) return { reason: "invalid_signature", message: `The decision is not a signed ${DECISION_FORMAT} record.` };
  const r = signed.record;
  if (!keys.has(r.key)) return { reason: "unknown_key", message: `No public key ${r.key} is among the runtime's decision keys.` };
  if (!signatureHolds(signed, keys)) return { reason: "invalid_signature", message: `The signature does not verify under key ${r.key}.` };
  if (!own(lock.members, r.member)?.keys.includes(r.key)) {
    return { reason: "unknown_key", message: `The package's lock does not list key ${r.key} under member ${r.member}.` };
  }
  return undefined;
}

/**
 * The second half of rule 2: the member holds the role the wait asks, and
 * decides in that role. A wait that asks no role takes any member the lock
 * lists, deciding in no role.
 */
export function roleRefusal(record: DecisionRecord, lock: Lock, role: string | undefined): Refusal | undefined {
  if (role === undefined) return record.role === undefined ? undefined : { reason: "not_in_role", message: `The decision is made as ${record.role}, and no role is asked.` };
  if (record.role !== role) return { reason: "not_in_role", message: `Role ${role} is asked; the decision is made as ${record.role ?? "no role"}.` };
  if (!own(lock.roles, role)?.includes(record.member)) return { reason: "not_in_role", message: `Member ${record.member} does not hold role ${role} in the package's lock.` };
  return undefined;
}

/**
 * Rule 3 of acceptance: the record names the package, run, revision, command
 * and subject the run shows now, is of a kind that answers it, and carries
 * the digest of what comes with it (`payload`: the answer, the new limits,
 * the reconciliation; none for an approval, a decline or a cancel). A
 * decision on another revision is `stale_revision`; a cancel is taken on any
 * revision, so `shown.revision` is absent for it. An envelope's approval is
 * about a package and no run: `shown` has no run, and the record must name
 * none, nor a revision or a command.
 */
export function shownRefusal(record: DecisionRecord, shown: Omit<Shown, "run" | "revision" | "role"> & { run?: string; revision?: number }, kinds: readonly DecisionKind[], payload?: string): Refusal | undefined {
  if (record.package !== shown.package || record.run !== shown.run) {
    const of = (run: string | undefined, pkg: string): string => `${run === undefined ? "" : `run ${run} of `}package ${pkg}`;
    return { reason: "subject_mismatch", message: `The decision is for ${of(record.run, record.package)}, not for ${of(shown.run, shown.package)}.` };
  }
  if (!kinds.includes(record.kind)) return { reason: "subject_mismatch", message: `A decision of kind ${record.kind} does not answer this; it takes ${kinds.join(" or ")}.` };
  if (shown.revision !== undefined && record.revision !== shown.revision) {
    return { reason: "stale_revision", message: `The decision was made on revision ${record.revision ?? "(none)"}; run ${shown.run} is at revision ${shown.revision}.` };
  }
  if (shown.run === undefined && record.revision !== undefined) return { reason: "subject_mismatch", message: "The decision names a revision, and it is about a package, not a run." };
  if (record.command !== shown.command) return { reason: "subject_mismatch", message: `The decision names ${record.command ?? "no command"}; the run shows ${shown.command ?? "none"}.` };
  if (record.subject !== shown.subject) return { reason: "subject_mismatch", message: "The decision names something other than what is waiting for it." };
  if (record.payload !== payload) return { reason: "subject_mismatch", message: payload === undefined ? `A decision of kind ${record.kind} carries no payload.` : "The decision's payload is not the digest of what was sent with it." };
  return undefined;
}

/** An accepted decision as the runtime keeps it. */
export interface StoredDecision {
  decision_id: string;
  record: DecisionRecord;
  signature: string;
}

/**
 * Why a stored decision is not one: its record no longer hashes to its id
 * (it was changed after signing), its signature does not verify, or the
 * package's lock does not bind its key to its member and role.
 */
export function storedProblem(d: StoredDecision, keys: TrustedKeys, lock: Lock): string | undefined {
  if (!isSignedDecision({ record: d.record, signature: d.signature })) return "its record is not a decision record";
  if (decisionId(d.record) !== d.decision_id) return "its record was changed after it was signed";
  const why = signerRefusal({ record: d.record, signature: d.signature }, keys, lock) ?? roleRefusal(d.record, lock, d.record.role);
  return why ? why.message : undefined;
}

/**
 * The id of the authorization a person's approval of an action makes. It
 * names the action's digest, who approved, and the message that carried the
 * approval, so the journal's `action_authorized` can be told to be that
 * message's doing.
 */
export function authorizationId(actionDigest: string, by: string, messageId: string): string {
  return digest("operation", { authorize: actionDigest, by, message: messageId });
}

/**
 * Why the evidence of a `human.approve` criterion does not hold, as far as
 * its decision goes (H04). The evidence record names the decision's digest;
 * the decision must be stored, unchanged, signed by a key the lock binds to
 * its role, and be the decision of this criterion with this result. With
 * `required` (signed mode), an approval that names no decision is none.
 */
export function approvalProblem(record: EvidenceRecord, decisions: ReadonlyMap<string, StoredDecision>, keys: TrustedKeys, lock: Lock, required: boolean): string | undefined {
  if (record.method !== "human.approve") return undefined;
  const p = isObj(record.producer) ? record.producer : {};
  const id = p["decision"];
  if (typeof id !== "string") return required && record.passed ? "the approval names no signed decision" : undefined;
  const d = decisions.get(id);
  if (!d) return `decision ${id} is not recorded`;
  const why = storedProblem(d, keys, lock);
  if (why) return `decision ${id}: ${why}`;
  const r = d.record;
  const criterion = (r.command ?? "").replace(/\/call$/, "");
  if (
    r.run !== record.run ||
    r.package !== record.package ||
    r.kind !== (record.passed ? "approve" : "decline") ||
    r.member !== p["member"] ||
    r.key !== p["key"] ||
    (r.role ?? null) !== (p["role"] ?? null) ||
    digest("request", { run: record.run, criterion, method: record.method, passed: record.passed }) !== record.evidence_id
  ) {
    return `decision ${id} is not the decision of this criterion`;
  }
  return undefined;
}

// ── keys ────────────────────────────────────────────────────────────────

/**
 * The members' public keys: every `<key id>.pem` in `dir`, where the name is
 * the key id without `sha256:`. A file whose key does not hash to its name is
 * refused: the lock names keys by id, and a file under another key's name
 * would stand for it.
 */
export function decisionKeysIn(dir: string): TrustedKeys {
  const keys = new TrustedKeys();
  if (!existsSync(dir)) return keys;
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".pem")).sort()) {
    let key: KeyObject;
    try {
      key = createPublicKey(readFileSync(join(dir, f), "utf8"));
    } catch {
      throw new Violation("bad_decision_key", `${join(dir, f)} is not a public key.`);
    }
    if (key.asymmetricKeyType !== "ed25519") throw new Violation("bad_decision_key", `${join(dir, f)} is ${key.asymmetricKeyType ?? "not a key"}; a decision key is ed25519.`);
    const id = keyIdOf(key);
    if (`sha256:${f.slice(0, -".pem".length)}` !== id) throw new Violation("bad_decision_key", `${join(dir, f)} holds the key ${id}, which is not the key its name says.`);
    keys.add(key);
  }
  return keys;
}

/** The file name of a public key in a decision keys directory. */
export function keyFileName(keyId: string): string {
  return `${keyId.slice("sha256:".length)}.pem`;
}

/**
 * Creates a member's key in `file`, readable by its owner only, and returns
 * it. An existing file is never replaced: a key that signed decisions is
 * someone's identity.
 */
export function newDecisionKey(file: string): EvidenceSigner {
  if (existsSync(file)) throw new Violation("key_exists", `${file} exists; a key is not replaced.`);
  return EvidenceSigner.createIn(file);
}

/**
 * Why a private key file must not be used: on POSIX, anyone but its owner can
 * read or write it. Windows has no such modes, and its ACLs are not read
 * here: there the file is as private as the directory it is in.
 */
export function privateKeyProblem(file: string): string | undefined {
  if (process.platform === "win32") return undefined;
  const mode = statSync(file).mode & 0o777;
  return mode & 0o077 ? `${file} is readable or writable by others (mode ${mode.toString(8).padStart(3, "0")}); make it yours only: chmod 600 ${file}` : undefined;
}

/** Reads a member's private key, refusing a file others can read. */
export function readDecisionKey(file: string): EvidenceSigner {
  if (!existsSync(file)) throw new Violation("no_key", `No key file ${file}.`);
  const problem = privateKeyProblem(file);
  if (problem) throw new Violation("key_not_private", problem);
  try {
    return EvidenceSigner.fromPem(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Violation("bad_decision_key", `${file} is not an ed25519 private key: ${(e as Error).message}`);
  }
}
