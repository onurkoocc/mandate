// Signed evidence records (P2-11, Doc 4 §10.3): every check writes a record
// of what was checked, against what, by whom, with which outputs and when,
// signed with the control plane's ed25519 key. A record that does not verify
// against a trusted key is not evidence: a Verified value that leans on one
// is refused before anything is prepared.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterAll } from "vitest";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "../src/evidence.js";
import { Runtime } from "../src/runtime.js";
import { SimTool, SimVerifier } from "../src/sim.js";
import { isObj } from "../src/values.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";
import { closeAll, world, type World } from "./helpers.js";

afterAll(closeAll);

async function fixbug(): Promise<World & { pr: SimTool }> {
  const pr = new SimTool("git.open_pr");
  const w = await world(FIXBUG, { tools: [pr], agents: fixbugAgents(), verifier: new SimVerifier() });
  return { ...w, pr };
}

async function approveOwner(w: World, runId: string) {
  const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
  const wait = waitOf(waiting.waiting);
  return w.rt.decideAction(runId, { sender: "carol", messageId: `${runId}-owner` }, { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
}

describe("evidence records (§10.3)", () => {
  it("signs every record with the control plane's key, naming what was checked, by whom, with which outputs", async () => {
    const w = await fixbug();
    const done = await approveOwner(w, "ev1");
    expect(done.state).toBe("succeeded");
    const rows = await w.rt.evidence("ev1");
    expect(rows).toHaveLength(6);
    for (const r of rows) {
      const rec = r.record as unknown as EvidenceRecord;
      expect(rec).toMatchObject({ format: "mandate/evidence/0.1", evidence_id: r.evidence_id, run: "ev1", package: w.pkg.hash, contract: "FixAccepted", criterion: r.criterion, method: r.method, passed: true });
      expect(rec.contract_hash).toMatch(/^sha256:/);
      expect(rec.subject).toMatchObject({ contract_args: expect.stringMatching(/^sha256:/) });
      expect(r.key_id).toBe(w.rt.signer.keyId);
      expect(r.signature).toMatch(/^ed25519:/);
    }
    const by = Object.fromEntries(rows.map((r) => [`${r.criterion}/${r.method}`, (r.record as unknown as EvidenceRecord).producer]));
    expect(by["scope_respected/static"]).toEqual({ kind: "runtime", handler: "mandate-runtime@0.2" });
    expect(by["owner_approved/human.approve"]).toEqual({ kind: "person", by: "carol", role: "code_owner", via: "DecideAction" });
    expect(by["suite_green/test.suite"]).toEqual({ kind: "verifier", handler: "sim-verifier" });
    // A test's outputs are artifacts of the run.
    const suite = rows.find((r) => r.criterion === "suite_green")!.record as unknown as EvidenceRecord;
    expect(suite.artifacts).toEqual([{ kind: "test_log", result: "pass", ref: expect.stringMatching(/^blob:sha256:/) }]);
    const log = await w.rt.artifact("ev1", String((suite.artifacts[0] as { ref: string }).ref));
    expect(new TextDecoder().decode(log.bytes)).toBe("sim: FixAccepted.suite_green passed\n");

    expect((await w.rt.verifyEvidence("ev1")).every((e) => e.valid)).toBe(true);
    // Another runtime with another key does not accept these records, unless it trusts this key.
    const other = new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts });
    expect((await other.verifyEvidence("ev1")).some((e) => e.valid)).toBe(false);
    const trusting = new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts, trustedKeys: [w.rt.signer.publicKeyPem()] });
    expect((await trusting.verifyEvidence("ev1")).every((e) => e.valid)).toBe(true);
  });

  it("shows a record changed after it was signed as invalid", async () => {
    const w = await fixbug();
    await approveOwner(w, "ev2");
    await w.db.query("update evidence set record = jsonb_set(record, '{detail}', '\"edited\"') where run_id = 'ev2' and criterion = 'suite_green'");
    const checked = await w.rt.verifyEvidence("ev2");
    expect(checked.filter((e) => !e.valid).map((e) => e.criterion)).toEqual(["suite_green"]);
  });

  it("refuses a Verified value whose evidence no longer holds, before anything is prepared (G03)", async () => {
    const w = await fixbug();
    // The worker dies once the contract is met, just before git.open_pr is prepared.
    w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
    await expect(approveOwner(w, "ev3")).rejects.toThrow(/crash at after_dispatch/);
    // Meanwhile someone without the key tampers with the evidence store: one record's signature no longer holds.
    await w.db.query("update evidence set signature = 'ed25519:AAAA' where run_id = 'ev3' and criterion = 'regression_test'");
    const resumed = await w.rt.resume("ev3");
    expect(resumed.state).toBe("attention_required");
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(String(isObj(resumed.attention) ? resumed.attention["message"] : "")).toContain("is not signed by a trusted key");
    expect(w.pr.prepares).toHaveLength(0);
    expect(await w.rt.journal.actions("ev3")).toHaveLength(0);
  });

  it("rotates the key: new evidence is signed by the new one, and evidence the old one signed still verifies", async () => {
    const w = await fixbug();
    await approveOwner(w, "ev4");
    const dir = mkdtempSync(join(tmpdir(), "mandate-keys-"));
    const file = join(dir, "evidence.key");
    writeFileSync(file, (w.rt.signer as unknown as { privateKey: { export(o: object): string } }).privateKey.export({ type: "pkcs8", format: "pem" }));
    const r = EvidenceSigner.rotate(file, join(dir, "trusted-keys"));
    expect(r.old).toBe(w.rt.signer.keyId);
    const next = EvidenceSigner.loadOrCreate(file);
    expect(next.keyId).toBe(r.current);
    expect(r.current).not.toBe(r.old);
    // The old private key is gone; only its public half is kept.
    expect(readFileSync(join(dir, "trusted-keys", `${r.old.slice("sha256:".length)}.pem`), "utf8")).toContain("PUBLIC KEY");
    const rotated = new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts, signer: next, trustedKeys: EvidenceSigner.trustedIn(join(dir, "trusted-keys")) });
    expect((await rotated.verifyEvidence("ev4")).every((e) => e.valid)).toBe(true);
    // Without the kept public key, the old evidence would not count.
    const forgetful = new Runtime(w.db, w.adapters, undefined, undefined, { artifacts: w.rt.artifacts, signer: next });
    expect((await forgetful.verifyEvidence("ev4")).some((e) => e.valid)).toBe(false);
  });

  it("keeps the key's id stable across loads and refuses keys that are not ed25519", () => {
    const a = EvidenceSigner.generate();
    const pem = (a as unknown as { privateKey: { export(o: object): string } }).privateKey.export({ type: "pkcs8", format: "pem" });
    const b = EvidenceSigner.fromPem(pem);
    expect(b.keyId).toBe(a.keyId);
    const record = { format: "mandate/evidence/0.1", evidence_id: "x" } as unknown as EvidenceRecord;
    expect(new TrustedKeys([b.publicKeyPem()]).verify(record, a.sign(record))).toBe(true);
    expect(new TrustedKeys([b.publicKeyPem()]).verify({ ...record, evidence_id: "y" }, a.sign(record))).toBe(false);
    expect(() => new TrustedKeys(["-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----\n"])).toThrow();
  });
});
