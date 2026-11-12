// A verifier of its own (Doc 4 §10.3; BACKLOG P2-11). The verifier can run
// as a separate process with its own ed25519 key, apart from the runtime
// that signs evidence. It signs what it found, its *check attestation*:
//
//   {
//     "format": "mandate/check-attestation/0.2",
//     "run": "…", "contract": "C", "criterion": "k", "method": "test.suite",
//     "part": "…/contract/accept/k",     the part of the criterion it checked
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
// subject, detail and logs, made for this check. The run, contract,
// criterion, method and part it names must be the record's own: the part,
// with the run, the method and the result, gives the record's evidence id.
// Which records must carry one is read from the program and the
// configuration (`recordProblem`), not from the record. The runtime never
// holds the verifier's key.
//
// A 0.1 attestation names none of these. It is still read, and still must
// hold, but it never stands for a check that requires an attestation.

import type { CheckBinding, CheckResult, VerifyRequest } from "./adapters.js";
import { sha256Of } from "./artifacts.js";
import { evidenceIdOf } from "./criteria.js";
import type { EvidenceRecord, Signature, TrustedKeys } from "./evidence.js";
import { digest, equal, isObj, type Value } from "./values.js";

/** The format of the attestations a verifier makes now: one that names the check it was made for. */
export const ATTESTATION_FORMAT = "mandate/check-attestation/0.2";
/** The format before it, which names no run, criterion or part. */
export const ATTESTATION_FORMAT_0_1 = "mandate/check-attestation/0.1";

/** What an attestation of either format says about a check's result. */
interface Found {
  request: string;
  passed: boolean;
  detail: Value;
  subject: Value;
  producer: Value;
  logs: Value[];
  cost: Value;
}

/** A 0.2 statement: what the check found, and in plain form the run, contract, criterion, method and part it was for. */
export interface CheckStatement extends Found {
  format: typeof ATTESTATION_FORMAT;
  run: string;
  contract: string;
  criterion: string;
  method: string;
  part: string;
}

/** A 0.1 statement: what the check found, and nothing of where. */
export interface CheckStatement01 extends Found {
  format: typeof ATTESTATION_FORMAT_0_1;
}

export interface Attestation extends Signature {
  statement: CheckStatement | CheckStatement01;
}

/**
 * What a verifier signs for one check: computed the same way on both sides of the process boundary. With the
 * check's binding (the run and the part), a 0.2 statement; without one, as before, a 0.1 statement.
 */
export function statementOf(req: VerifyRequest, r: CheckResult, binding: CheckBinding): CheckStatement;
export function statementOf(req: VerifyRequest, r: CheckResult, binding?: CheckBinding): CheckStatement | CheckStatement01;
export function statementOf(req: VerifyRequest, r: CheckResult, binding?: CheckBinding): CheckStatement | CheckStatement01 {
  const found: Found = {
    request: digest("request", req as unknown as Value),
    passed: r.passed,
    detail: r.detail ?? null,
    subject: (r.subject?.files ?? null) as Value,
    producer: r.producer ?? null,
    logs: (r.logs ?? []).map((l) => ({ kind: l.kind, ...(l.phase !== undefined ? { phase: l.phase } : {}), ...(l.result !== undefined ? { result: l.result } : {}), digest: sha256Of(l.content) })),
    cost: (r.cost ?? null) as unknown as Value,
  };
  if (!binding) return { format: ATTESTATION_FORMAT_0_1, ...found };
  return { format: ATTESTATION_FORMAT, run: binding.run, contract: req.contract, criterion: req.criterion, method: req.method, part: binding.part, ...found };
}

/**
 * Why a record's attestation does not hold, or undefined when it holds. It
 * must be signed by a trusted verifier key, and say what the record says:
 * passed, detail, the files checked, and each output by digest. A 0.2
 * attestation must also have been made for this record's check: its run,
 * contract, criterion and method are the record's, and its part gives the
 * record's evidence id. A record with no attestation, or with a 0.1 one,
 * holds only when none is `required`: the caller says so from the program
 * and the configuration (`recordProblem`), never from the record.
 */
export function attestationProblem(record: EvidenceRecord, keys: TrustedKeys | undefined, required = false): string | undefined {
  const producer = isObj(record.producer) ? record.producer : undefined;
  const att = producer?.["attestation"];
  if (att === undefined) return required ? "its check carries no verifier attestation" : undefined;
  if (!isObj(att) || !isObj(att["statement"] ?? null) || typeof att["key_id"] !== "string" || typeof att["signature"] !== "string") return "its verifier attestation is malformed";
  const statement = att["statement"] as unknown as CheckStatement | CheckStatement01;
  // Each format is signed under its own name, so one never verifies as the other.
  const format = statement.format === ATTESTATION_FORMAT || statement.format === ATTESTATION_FORMAT_0_1 ? statement.format : undefined;
  if (!format || !keys || !keys.verifyStatement(format, statement as unknown as Value, { key_id: att["key_id"], signature: att["signature"] })) return "its check is not attested by a trusted verifier key";
  const subject = isObj(record.subject) ? (record.subject["files"] ?? null) : null;
  const refs = record.artifacts.map((a) => (isObj(a) && typeof a["ref"] === "string" ? a["ref"].replace(/^blob:/, "") : null));
  const logs = statement.logs.map((l) => (isObj(l) ? (l["digest"] ?? null) : null));
  if (statement.passed !== record.passed || !equal(statement.detail, record.detail) || !equal(statement.subject, subject) || !equal(logs, refs)) return "it says something other than its verifier attested";
  if (statement.format === ATTESTATION_FORMAT_0_1) return required ? "its verifier attestation does not name the check it was made for (mandate/check-attestation/0.1)" : undefined;
  if (statement.run !== record.run) return "its verifier attestation was made in another run";
  if (statement.contract !== record.contract) return "its verifier attestation was made for another contract";
  if (statement.criterion !== record.criterion) return "its verifier attestation was made for another criterion";
  if (statement.method !== record.method) return "its verifier attestation was made for another method";
  if (typeof statement.part !== "string" || evidenceIdOf(statement.run, statement.part, statement.method, record.passed) !== record.evidence_id) return "its verifier attestation was made for another part of its criterion";
  return undefined;
}

/** Which checks must come with a verifier's attestation: under these verifier keys, all but the methods checked in the runtime's process. */
export interface AttestationRule {
  keys: TrustedKeys | undefined;
  inProcess: ReadonlySet<string>;
}

/** Whether a verifier of its own is configured: some verifier key is trusted. Without one, no check is attested. */
export function attestationsRequired(rule: AttestationRule): boolean {
  return !!rule.keys && rule.keys.ids().length > 0;
}

/**
 * Whether evidence of `method` must carry a verifier attestation: when a verifier of its own is configured, for
 * every method but a static part, a person's approval, and the methods the configuration checks in the runtime's
 * process (boundary and onboarding checks).
 */
export function attestedMethod(method: string, rule: AttestationRule): boolean {
  return attestationsRequired(rule) && method !== "static" && method !== "human.approve" && !rule.inProcess.has(method);
}

/**
 * Why a stored evidence record, already checked against its signature, does not hold as a check of what the
 * program declares, or undefined when it holds. `stored` is the store's row and the run it is stored under; `declared`, the methods the program
 * declares for the record's contract and criterion (criteria.ts `criterionMethods`).
 *
 * With a verifier of its own configured, the row must name the run, contract, criterion and method its signed record
 * names, the method must be one the program declares for that criterion, and a method that is attested must
 * carry an attestation that holds. So whether a record needs an attestation is read from the program and the
 * configuration: a record whose attestation was taken out, or whose method was changed, does not hold, whatever
 * key signed it. Without a verifier of its own, only an attestation the record carries is checked.
 */
export function recordProblem(record: EvidenceRecord, stored: { run: string; contract: string; criterion: string; method: string }, declared: readonly string[] | undefined, rule: AttestationRule): string | undefined {
  if (!attestationsRequired(rule)) return attestationProblem(record, rule.keys);
  if (stored.run !== record.run) return "its signed record is of another run";
  if (stored.contract !== record.contract || stored.criterion !== record.criterion || stored.method !== record.method) return "its stored row does not name what its signed record names";
  if (!declared) return `${record.contract}.${record.criterion} is not a criterion of the program`;
  if (!declared.includes(record.method)) return `${record.contract}.${record.criterion} declares no check by ${record.method}`;
  return attestationProblem(record, rule.keys, attestedMethod(record.method, rule));
}
