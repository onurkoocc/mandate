// A verifier of its own (Doc 4 §10.3; BACKLOG P2-11). The verifier can run
// as a separate process with its own ed25519 key, apart from the runtime
// that signs evidence. It signs what it found, its *check attestation*:
//
//   {
//     "format": "mandate/check-attestation/0.1",
//     "request": "sha256:…",            the VerifyRequest's digest
//     "passed": true, "detail": …,
//     "subject": { "src/a.ts": "sha256:…" } | null,
//     "producer": { "kind": "runtime", "handler": "mandate-sandbox-verifier@0.2", … } | null,
//     "logs": [ { "kind": "test_log", "phase": "after", "result": "pass", "digest": "sha256:…" } ],
//     "cost": … | null
//   }
//
// The runtime accepts a check only when the attestation verifies against a
// verifier key it trusts, and keeps it in the evidence record's `producer`.
// So the runtime's key alone cannot make a check pass: a record that says
// `passed` must also carry the verifier's signature over the same result,
// subject, detail and logs. The runtime never holds the verifier's key.

import type { CheckResult, VerifyRequest } from "./adapters.js";
import { sha256Of } from "./artifacts.js";
import type { EvidenceRecord, Signature, TrustedKeys } from "./evidence.js";
import { digest, equal, isObj, type Value } from "./values.js";

export const ATTESTATION_FORMAT = "mandate/check-attestation/0.1";

export interface CheckStatement {
  format: typeof ATTESTATION_FORMAT;
  request: string;
  passed: boolean;
  detail: Value;
  subject: Value;
  producer: Value;
  logs: Value[];
  cost: Value;
}

export interface Attestation extends Signature {
  statement: CheckStatement;
}

/** What a verifier signs for one check: computed the same way on both sides of the process boundary. */
export function statementOf(req: VerifyRequest, r: CheckResult): CheckStatement {
  return {
    format: ATTESTATION_FORMAT,
    request: digest("request", req as unknown as Value),
    passed: r.passed,
    detail: r.detail ?? null,
    subject: (r.subject?.files ?? null) as Value,
    producer: r.producer ?? null,
    logs: (r.logs ?? []).map((l) => ({ kind: l.kind, ...(l.phase !== undefined ? { phase: l.phase } : {}), ...(l.result !== undefined ? { result: l.result } : {}), digest: sha256Of(l.content) })),
    cost: (r.cost ?? null) as unknown as Value,
  };
}

/**
 * Why a record's attestation does not hold, or undefined when it holds or
 * the record makes no claim of one (a check the runtime ran itself, or an
 * approval). It must be signed by a trusted verifier key, and say what the
 * record says: passed, detail, the files checked, and each output by digest.
 */
export function attestationProblem(record: EvidenceRecord, keys: TrustedKeys | undefined): string | undefined {
  const producer = isObj(record.producer) ? record.producer : undefined;
  const att = producer?.["attestation"];
  if (att === undefined) return undefined;
  if (!isObj(att) || !isObj(att["statement"] ?? null) || typeof att["key_id"] !== "string" || typeof att["signature"] !== "string") return "its verifier attestation is malformed";
  const statement = att["statement"] as unknown as CheckStatement;
  if (!keys || !keys.verifyStatement(ATTESTATION_FORMAT, statement as unknown as Value, { key_id: att["key_id"], signature: att["signature"] })) return "its check is not attested by a trusted verifier key";
  const subject = isObj(record.subject) ? (record.subject["files"] ?? null) : null;
  const refs = record.artifacts.map((a) => (isObj(a) && typeof a["ref"] === "string" ? a["ref"].replace(/^blob:/, "") : null));
  const logs = statement.logs.map((l) => (isObj(l) ? (l["digest"] ?? null) : null));
  if (statement.passed !== record.passed || !equal(statement.detail, record.detail) || !equal(statement.subject, subject) || !equal(logs, refs)) return "it says something other than its verifier attested";
  return undefined;
}
