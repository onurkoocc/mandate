// Evidence records (Doc 4 §10.3). When a criterion is checked, the runtime
// writes a record that says what was checked, against what, by whom, with
// which outputs and when, and signs it with the control plane's ed25519 key.
// The agent never produces evidence: a model's "the tests passed" is not a
// record, and a record that does not verify against a trusted key is not
// evidence (INV-04, G03).
//
//   {
//     "format": "mandate/evidence/0.1",
//     "evidence_id": "sha256:…", "run": "…", "package": "sha256:…",
//     "contract": "FixAccepted", "contract_hash": "sha256:…",
//     "criterion": "regression_test", "method": "test.red_then_green",
//     "passed": true,
//     "subject":   { "contract_args": "sha256:…", "files": { "src/a.ts": "sha256:…" }, "tree": "blob:sha256:…" },
//     "producer":  { "kind": "runtime", "handler": "mandate-sandbox-verifier@0.2", "sandbox": "mxc:process" },
//     "artifacts": [ { "kind": "test_log", "phase": "before", "result": "fail", "ref": "blob:sha256:…" } ],
//     "detail": { … },
//     "at": 1791234567890
//   }
//
// The signature covers "mandate/evidence/0.1\n" followed by the record's JCS
// bytes, and is stored as `ed25519:<base64>` with the key's id, the SHA-256
// of its public key (SPKI DER).

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonical, type Value } from "./values.js";

export const EVIDENCE_FORMAT = "mandate/evidence/0.1";

export interface EvidenceRecord {
  format: typeof EVIDENCE_FORMAT;
  evidence_id: string;
  run: string;
  package: string;
  contract: string;
  contract_hash: string;
  criterion: string;
  method: string;
  passed: boolean;
  subject: Value;
  producer: Value;
  artifacts: Value[];
  detail: Value;
  at: number;
}

export interface Signature {
  key_id: string;
  signature: string;
}

/** What a signature covers: the statement's format, a newline, and the statement's JCS bytes. */
function message(format: string, statement: Value): Buffer {
  return Buffer.from(`${format}\n${canonical(statement)}`, "utf8");
}

/** The id of a public key: the SHA-256 of its SPKI DER encoding. */
export function keyIdOf(key: KeyObject): string {
  return `sha256:${createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex")}`;
}

/** The control plane's evidence key. It never leaves the runtime process; agents' sandboxes never see it. */
export class EvidenceSigner {
  readonly keyId: string;
  readonly publicKey: KeyObject;

  private constructor(private readonly privateKey: KeyObject) {
    this.publicKey = createPublicKey(privateKey);
    this.keyId = keyIdOf(this.publicKey);
  }

  static generate(): EvidenceSigner {
    return new EvidenceSigner(generateKeyPairSync("ed25519").privateKey);
  }

  static fromPem(pem: string): EvidenceSigner {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "ed25519") throw new Error(`An evidence key must be ed25519, not ${key.asymmetricKeyType}.`);
    return new EvidenceSigner(key);
  }

  /** Reads the key in `file`, or creates one there (readable by its owner only). */
  static loadOrCreate(file: string): EvidenceSigner {
    if (existsSync(file)) return EvidenceSigner.fromPem(readFileSync(file, "utf8"));
    const signer = EvidenceSigner.generate();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, signer.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    try {
      chmodSync(file, 0o600);
    } catch {
      // Windows has no POSIX modes; the file is in the operator's own directory.
    }
    return signer;
  }

  /**
   * Replaces the key in `file` with a new one. The old key's public half is
   * kept in `trustedDir` as `<key id>.pem`, so evidence it signed still
   * verifies; its private half is gone. Returns both key ids.
   */
  static rotate(file: string, trustedDir: string): { old: string; current: string } {
    const old = EvidenceSigner.loadOrCreate(file);
    mkdirSync(trustedDir, { recursive: true });
    writeFileSync(join(trustedDir, `${old.keyId.slice("sha256:".length)}.pem`), old.publicKeyPem());
    const next = EvidenceSigner.generate();
    writeFileSync(file, next.privateKey.export({ type: "pkcs8", format: "pem" }) as string, { mode: 0o600 });
    return { old: old.keyId, current: next.keyId };
  }

  /** The public keys kept in `trustedDir` by earlier rotations. */
  static trustedIn(trustedDir: string): string[] {
    if (!existsSync(trustedDir)) return [];
    return readdirSync(trustedDir)
      .filter((f) => f.endsWith(".pem"))
      .sort()
      .map((f) => readFileSync(join(trustedDir, f), "utf8"));
  }

  publicKeyPem(): string {
    return this.publicKey.export({ type: "spki", format: "pem" }) as string;
  }

  sign(record: EvidenceRecord): Signature {
    return this.signStatement(EVIDENCE_FORMAT, record as unknown as Value);
  }

  /** Signs any statement of a named format, e.g. a verifier's check attestation. */
  signStatement(format: string, statement: Value): Signature {
    return { key_id: this.keyId, signature: `ed25519:${sign(null, message(format, statement), this.privateKey).toString("base64")}` };
  }
}

/** Public keys whose evidence signatures a runtime accepts, by key id. */
export class TrustedKeys {
  private readonly keys = new Map<string, KeyObject>();

  constructor(keys: Array<KeyObject | string> = []) {
    for (const k of keys) this.add(k);
  }

  add(key: KeyObject | string): this {
    const pub = typeof key === "string" ? createPublicKey(key) : key.type === "private" ? createPublicKey(key) : key;
    if (pub.asymmetricKeyType !== "ed25519") throw new Error(`A trusted evidence key must be ed25519, not ${pub.asymmetricKeyType}.`);
    this.keys.set(keyIdOf(pub), pub);
    return this;
  }

  /** Whether `sig` is a valid signature of `record` by one of these keys. */
  verify(record: EvidenceRecord, sig: Signature): boolean {
    return this.verifyStatement(EVIDENCE_FORMAT, record as unknown as Value, sig);
  }

  /** Whether `sig` is a valid signature of a statement of `format` by one of these keys. */
  verifyStatement(format: string, statement: Value, sig: Signature): boolean {
    const key = this.keys.get(sig.key_id);
    if (!key || typeof sig.signature !== "string" || !sig.signature.startsWith("ed25519:")) return false;
    try {
      return verify(null, message(format, statement), key, Buffer.from(sig.signature.slice("ed25519:".length), "base64"));
    } catch {
      return false;
    }
  }

  ids(): string[] {
    return [...this.keys.keys()].sort();
  }
}
