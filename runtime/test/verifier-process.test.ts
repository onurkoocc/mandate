// A verifier of its own (BACKLOG P2-11, Doc 4 §10.3): the checks run in a
// separate process that signs each result with its own key. The runtime
// accepts a result only under a trusted verifier key, keeps the attestation
// in the evidence record, and refuses a record whose check its verifier did
// not attest, even when the runtime's own key signed it.

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../src/adapters.js";
import { attestationProblem } from "../src/attestation.js";
import { readConfig, verifierKeys } from "../src/control.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "../src/evidence.js";
import { Runtime } from "../src/runtime.js";
import { SimTool } from "../src/sim.js";
import { ProcessVerifier } from "../src/verifier-service.js";
import { isObj } from "../src/values.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";
import { closeAll, world, type World } from "./helpers.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const out = here("./.build");
const verifiers: ProcessVerifier[] = [];

/** Bundles a TypeScript entry point so a plain `node` child can run it; packages stay external. */
async function bundle(entry: string, name: string): Promise<string> {
  const outfile = join(out, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@mandate/compiler": here("../../compiler/src/index.ts") },
    external: ["pg", "@electric-sql/pglite", "@anthropic-ai/sdk", "@temporalio/*", "ajv", "ajv/*", "ajv-formats", "@microsoft/mxc-sdk", "@microsoft/mxc-sdk/*"],
    logLevel: "error",
  });
  return outfile;
}

let child: string;
let main: string;
beforeAll(async () => {
  mkdirSync(out, { recursive: true });
  child = await bundle(here("./fixtures/sim-verifier-process.ts"), "sim-verifier-process");
  main = await bundle(here("../src/verifier-main.ts"), "verifier-main");
}, 60_000);

afterAll(async () => {
  for (const v of verifiers) v.close();
  await closeAll();
});

const keys = mkdtempSync(join(tmpdir(), "mandate-verifier-"));

/** FixBug, with its checks made by a verifier process whose key is `verifierKey`, trusting `trusted`. */
async function fixbug(o: { verifierKey: string; trusted: string[]; lie?: boolean }): Promise<World & { remote: ProcessVerifier }> {
  const w0 = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: fixbugAgents() });
  const verifier = new ProcessVerifier({
    command: [process.execPath, child, o.verifierKey, ...(o.lie ? ["lie"] : [])],
    trusted: new TrustedKeys(o.trusted),
    package: { program: w0.pkg.program, lock: w0.pkg.lock },
  });
  verifiers.push(verifier);
  (w0.adapters as Adapters).verifier = verifier;
  const rt = new Runtime(w0.db, w0.adapters, w0.faults, undefined, { artifacts: w0.rt.artifacts, signer: w0.rt.signer, trustedVerifiers: new TrustedKeys(o.trusted) });
  return { ...w0, rt, remote: verifier };
}

async function approveOwner(w: World, runId: string) {
  const waiting = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId });
  const wait = waitOf(waiting.waiting);
  return w.rt.decideAction(runId, { sender: "carol", messageId: `${runId}-owner` }, { commandId: wait.command, revision: waiting.revision, digest: String(wait.request["subject_digest"]), approve: true, by: "carol" });
}

/** The public half of the key the child creates at `file`. */
function publicOf(file: string): string {
  return EvidenceSigner.loadOrCreate(file).publicKeyPem();
}

describe("a verifier process of its own (P2-11)", () => {
  it("runs the checks in another process, and each record carries that verifier's signature", async () => {
    const key = join(keys, "v1.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)] });
    const done = await approveOwner(w, "vp1");
    expect(done.state, JSON.stringify(done.attention ?? done.error)).toBe("succeeded");
    const rows = await w.rt.evidence("vp1");
    // What the verifier checked; an approval, and what the runtime checks itself, carry no attestation.
    const checks = rows.filter((r) => ((r.record as unknown as EvidenceRecord).producer as Record<string, unknown>)["kind"] === "verifier");
    expect(checks.map((r) => r.criterion).sort()).toEqual(["no_blocking_review", "regression_test", "suite_green"]);
    for (const r of checks) {
      const producer = (r.record as unknown as EvidenceRecord).producer as Record<string, unknown>;
      expect(producer).toMatchObject({ kind: "verifier", handler: "sim-verifier", process: "separate", attestation: { key_id: EvidenceSigner.loadOrCreate(key).keyId, statement: { format: "mandate/check-attestation/0.1", passed: true } } });
    }
    expect((await w.rt.verifyEvidence("vp1")).every((e) => e.valid)).toBe(true);
    // The verifier says which key it signs with; the runtime trusts the pinned one, not this answer.
    expect((await w.remote.key()).key_id).toBe(EvidenceSigner.loadOrCreate(key).keyId);
  });

  it("does not count a check its verifier did not sign: a result changed on the way is not met", async () => {
    const key = join(keys, "v2.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)], lie: true });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "vp2" });
    expect(run.state).not.toBe("succeeded");
    const rt = (await w.rt.evidence("vp2")).find((r) => r.criterion === "regression_test")!;
    expect(rt.passed).toBe(false);
    expect(rt.detail).toMatchObject({ reason: "unattested_check" });
  });

  it("does not count a check signed by a verifier key the runtime does not trust", async () => {
    const w = await fixbug({ verifierKey: join(keys, "v3.key"), trusted: [EvidenceSigner.generate().publicKeyPem()] });
    const run = await w.rt.startRun({ pkg: w.pkg, workflow: "FixBug", input: BUG, runId: "vp3" });
    expect(run.state).not.toBe("succeeded");
    const checked = (await w.rt.evidence("vp3")).filter((r) => isObj(r.detail) && r.detail["reason"] === "unattested_check");
    expect(checked.length).toBeGreaterThan(0);
    expect(checked.every((r) => !r.passed)).toBe(true);
  });

  it("refuses a record the runtime's key signed but the verifier did not attest: that key alone cannot make a check pass", async () => {
    const key = join(keys, "v4.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)] });
    await approveOwner(w, "vp4");
    const row = (await w.rt.evidence("vp4")).find((r) => r.criterion === "regression_test")!;
    const record = row.record as unknown as EvidenceRecord;
    const verifierKeys = new TrustedKeys([publicOf(key)]);
    expect(attestationProblem(record, verifierKeys)).toBeUndefined();
    // Whoever holds the runtime's key rewrites what the check found, and signs it again.
    const forged: EvidenceRecord = { ...record, detail: { method: "test.red_then_green", note: "edited" } };
    expect(attestationProblem(forged, verifierKeys)).toBe("it says something other than its verifier attested");
    const sig = w.rt.signer.sign(forged);
    await w.db.query("update evidence set record = $2, signature = $3 where evidence_id = $1", [row.evidence_id, JSON.stringify(forged), sig.signature]);
    const checked = await w.rt.verifyEvidence("vp4");
    expect(checked.filter((e) => !e.valid).map((e) => e.criterion)).toEqual(["regression_test"]);
    // Without the verifier's key, no attestation verifies at all.
    expect(attestationProblem(record, new TrustedKeys())).toBe("its check is not attested by a trusted verifier key");
  });

  it("is set up from mandate.runtime.json: the verifier process creates its own key, the runtime pins its public half", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-vconf-"));
    writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", verifier: { workdir: ".", base: "seed", suites: {}, process: {} } }));
    const config = readConfig(join(dir, "mandate.runtime.json"));
    expect(config.verifier?.process).toEqual({ key: join(dir, ".mandate", "verifier.key") });
    const trusted = verifierKeys(config, [process.execPath, main]);
    expect(existsSync(join(dir, ".mandate", "verifier.key"))).toBe(true);
    expect(readFileSync(join(dir, ".mandate", "verifier.key.pub"), "utf8")).toContain("PUBLIC KEY");
    expect(trusted.ids()).toEqual([EvidenceSigner.loadOrCreate(join(dir, ".mandate", "verifier.key")).keyId]);
    writeFileSync(join(dir, "bad.json"), JSON.stringify({ database: "pglite:db", verifier: { workdir: ".", base: "seed", suites: {}, process: { secret: 1 } } }));
    expect(() => readConfig(join(dir, "bad.json"))).toThrow(/unknown field verifier\.process\.secret/);
  });
});
