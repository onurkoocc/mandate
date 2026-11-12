// A verifier of its own (BACKLOG P2-11, Doc 4 §10.3): the checks run in a
// separate process that signs each result with its own key. The runtime
// accepts a result only under a trusted verifier key, keeps the attestation
// in the evidence record, and refuses a record whose check its verifier did
// not attest, even when the runtime's own key signed it.

import { mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, type Lock } from "@mandate/compiler";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Adapters } from "../src/adapters.js";
import { attestationProblem } from "../src/attestation.js";
import { BOUNDARY_METHODS } from "../src/boundary.js";
import { adaptersFor, inProcessMethods, readConfig, verifierKeys } from "../src/control.js";
import { uncovered } from "../src/criteria.js";
import { EvidenceSigner, TrustedKeys, type EvidenceRecord } from "../src/evidence.js";
import type { EvidenceRow, RunRow } from "../src/journal.js";
import { ONBOARD_METHODS } from "../src/onboard.js";
import { Runtime } from "../src/runtime.js";
import { SimTool } from "../src/sim.js";
import { ProcessVerifier } from "../src/verifier-service.js";
import { isObj, type Value } from "../src/values.js";
import { BUG, FIXBUG, fixbugAgents, waitOf } from "./fixbug.js";
import { closeAll, world, type World, UNSIGNED } from "./helpers.js";

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

/**
 * FixBug, with its checks made by a verifier process whose key is `verifierKey`, trusting `trusted`; `inProcess`
 * names the methods the runtime is told it checks in its own process.
 */
async function fixbug(o: { verifierKey: string; trusted: string[]; lie?: boolean; inProcess?: readonly string[] }): Promise<World & { remote: ProcessVerifier }> {
  const w0 = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: fixbugAgents() });
  const verifier = new ProcessVerifier({
    command: [process.execPath, child, o.verifierKey, ...(o.lie ? ["lie"] : [])],
    trusted: new TrustedKeys(o.trusted),
    package: { program: w0.pkg.program, lock: w0.pkg.lock },
  });
  verifiers.push(verifier);
  (w0.adapters as Adapters).verifier = verifier;
  const rt = new Runtime(w0.db, w0.adapters, w0.faults, undefined, { ...UNSIGNED, artifacts: w0.rt.artifacts, signer: w0.rt.signer, trustedVerifiers: new TrustedKeys(o.trusted), ...(o.inProcess ? { inProcessMethods: o.inProcess } : {}) });
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

// ── The verifier process's environment ────────────────────────────────

describe("the verifier process's environment", () => {
  let envMain: string;
  beforeAll(async () => {
    envMain = await bundle(here("./fixtures/env-verifier-process.ts"), "env-verifier-process");
  }, 60_000);

  /** What the runtime holds in its environment: none of it is the verifier's, but the model's key when it runs model-backed checks. */
  const SECRETS = { MANDATE_CANARY_KEY: "sk-canary", MANDATE_GITHUB_TOKEN: "ghp_not_a_token", MANDATE_PROD_SIM_CORE_URL: "postgresql://reader:not-a-password@db/core", CLAUDE_API_KEY: "sk-ant-not-a-key" };
  const FIXBUG_LOCK = JSON.parse(readFileSync(here("../../fixtures/fixbug/mandate.lock.json"), "utf8")) as Lock;

  /** With these secrets in the runtime's environment, what the verifier process sees: when it creates its key, and when it checks. */
  async function seen(o: { model: boolean }): Promise<{ init: Record<string, string>; check: Record<string, string> }> {
    const dir = mkdtempSync(join(tmpdir(), "mandate-venv-"));
    const file = join(dir, "mandate.runtime.json");
    writeFileSync(file, JSON.stringify({ database: "pglite:db", verifier: { workdir: ".", base: "seed", suites: {}, process: {} }, broker: { "prod_sim/core": { url_env: "MANDATE_PROD_SIM_CORE_URL" } }, ...(o.model ? { model: { provider: "anthropic" } } : {}) }));
    const saved = Object.fromEntries(Object.keys(SECRETS).map((k) => [k, process.env[k]]));
    Object.assign(process.env, SECRETS);
    try {
      const adapters = adaptersFor(readConfig(file), check(FIXBUG, "mdt").program!, FIXBUG_LOCK, process.env, [process.execPath, envMain]);
      const verifier = adapters.verifier as ProcessVerifier;
      verifiers.push(verifier);
      const r = await verifier.check({ method: "test.suite", args: [], named: {}, contract: "C", criterion: "k" });
      expect(r.passed, JSON.stringify(r.detail)).toBe(true);
      return { init: JSON.parse(readFileSync(join(dir, ".mandate", "verifier.key.env.json"), "utf8")) as Record<string, string>, check: (r.detail as { env: Record<string, string> }).env };
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  const names = (env: Record<string, string>): string[] => Object.keys(env).map((k) => k.toUpperCase());

  it("gets what a program needs and none of the runtime's secrets; the model's key only when the configuration has a model", async () => {
    const without = await seen({ model: false });
    const withModel = await seen({ model: true });
    for (const env of [without.init, without.check, withModel.init, withModel.check]) {
      expect(names(env)).toContain("PATH");
      for (const secret of ["MANDATE_CANARY_KEY", "MANDATE_GITHUB_TOKEN", "MANDATE_PROD_SIM_CORE_URL"]) expect(names(env)).not.toContain(secret);
    }
    // Creating its key needs no model; checking does when the configuration has one, and only then.
    expect(names(without.init)).not.toContain("CLAUDE_API_KEY");
    expect(names(withModel.init)).not.toContain("CLAUDE_API_KEY");
    expect(names(without.check)).not.toContain("CLAUDE_API_KEY");
    expect(withModel.check["CLAUDE_API_KEY"]).toBe(SECRETS.CLAUDE_API_KEY);
  });

  it("started without an environment of its own, gets only what a program needs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-venv-"));
    const file = join(dir, "mandate.runtime.json");
    writeFileSync(file, JSON.stringify({ database: "pglite:db", verifier: { workdir: ".", base: "seed", suites: {}, process: { key: "v.key" } } }));
    const key = EvidenceSigner.loadOrCreate(join(dir, "v.key"));
    process.env["MANDATE_CANARY_KEY"] = "sk-canary";
    try {
      const verifier = new ProcessVerifier({ command: [process.execPath, envMain, "--config", file], trusted: new TrustedKeys([key.publicKeyPem()]), package: { program: check(FIXBUG, "mdt").program!, lock: FIXBUG_LOCK } });
      verifiers.push(verifier);
      const r = await verifier.check({ method: "test.suite", args: [], named: {}, contract: "C", criterion: "k" });
      expect(r.passed, JSON.stringify(r.detail)).toBe(true);
      const env = (r.detail as { env: Record<string, string> }).env;
      expect(names(env)).toContain("PATH");
      expect(names(env)).not.toContain("MANDATE_CANARY_KEY");
    } finally {
      delete process.env["MANDATE_CANARY_KEY"];
    }
  });
});

// ── Which checks need an attestation (B20) ─────────────────────────────

/** FixBug approved by its code owner, with the worker dead just before git.open_pr is prepared: its evidence is recorded. */
async function approvedThenCrashed(w: World, runId: string): Promise<void> {
  w.faults.arm("after_dispatch", (i) => i.kind === "prepare");
  await expect(approveOwner(w, runId)).rejects.toThrow(/crash at after_dispatch/);
  expect((await w.rt.verifyEvidence(runId)).every((e) => e.valid)).toBe(true);
}

/** Whoever holds the runtime's key and its database rewrites one stored record, and its row with it, and signs it again. */
async function forge(w: World, runId: string, pick: (r: EvidenceRow) => boolean, edit: (r: EvidenceRecord) => EvidenceRecord): Promise<void> {
  const found = (await w.rt.evidence(runId)).find(pick)!;
  const forged = edit(found.record as unknown as EvidenceRecord);
  const sig = w.rt.signer.sign(forged);
  await w.db.query("update evidence set record = $2, signature = $3, method = $4 where evidence_id = $1", [found.evidence_id, JSON.stringify(forged), sig.signature, forged.method]);
}

/** The record with its verifier's attestation taken out, as if the runtime had checked it itself. */
function unattested(r: EvidenceRecord): EvidenceRecord {
  const { attestation: _a, process: _p, ...producer } = r.producer as Record<string, Value>;
  return { ...r, producer };
}

const invalid = async (w: World, runId: string) => (await w.rt.verifyEvidence(runId)).filter((e) => !e.valid).map((e) => e.criterion);
const said = (run: RunRow): string => String(isObj(run.attention) ? run.attention["message"] : "");

describe("with a verifier of its own, which checks need its attestation is the configuration's to say (B20)", () => {
  it("refuses a check whose attestation was taken out and that the runtime's key signed again", async () => {
    const key = join(keys, "v6.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)] });
    await approvedThenCrashed(w, "vp6");
    await forge(w, "vp6", (r) => r.criterion === "regression_test", unattested);
    expect(await invalid(w, "vp6")).toEqual(["regression_test"]);
    const resumed = await w.rt.resume("vp6");
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(said(resumed)).toContain("its check carries no verifier attestation");
    expect(w.tools["git.open_pr"]!.prepares).toHaveLength(0);
  });

  it.each([
    ["static", "a static part's"],
    ["test.suite_each", "a method the runtime checks in its own process"],
  ])("refuses a check whose method was changed to %s (%s) and signed again: the program says which method a criterion uses", async (method) => {
    const key = join(keys, `v7-${method}.key`);
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)], inProcess: BOUNDARY_METHODS });
    const runId = `vp7-${method}`;
    await approvedThenCrashed(w, runId);
    await forge(w, runId, (r) => r.criterion === "regression_test", (r) => ({ ...unattested(r), method }));
    expect(await invalid(w, runId)).toEqual(["regression_test"]);
    const resumed = await w.rt.resume(runId);
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(said(resumed)).toContain(`FixAccepted.regression_test declares no check by ${method}`);
    expect(w.tools["git.open_pr"]!.prepares).toHaveLength(0);
  });

  it("refuses a stored row that names another method than its signed record", async () => {
    const key = join(keys, "v8.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)] });
    await approvedThenCrashed(w, "vp8");
    await w.db.query("update evidence set method = 'static' where run_id = 'vp8' and criterion = 'regression_test'");
    expect(await invalid(w, "vp8")).toEqual(["regression_test"]);
    const resumed = await w.rt.resume("vp8");
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(said(resumed)).toContain("its stored row does not name what its signed record names");
  });

  it("does not let a static part's record stand for the verifier's check beside it under `and`", async () => {
    // no_blocking_review is `static not pr.review.blocking and review(…)`: the review's record is made a second static one.
    const key = join(keys, "v9.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)] });
    await approvedThenCrashed(w, "vp9");
    await forge(w, "vp9", (r) => r.criterion === "no_blocking_review" && r.method === "review", (r) => ({ ...unattested(r), method: "static" }));
    const resumed = await w.rt.resume("vp9");
    expect(resumed.attention).toMatchObject({ violation: "forged_evidence" });
    expect(said(resumed)).toContain("no evidence by review for FixAccepted.no_blocking_review");
    expect(w.tools["git.open_pr"]!.prepares).toHaveLength(0);
  });

  it("goes on to the pull request when nothing was changed", async () => {
    const key = join(keys, "v10.key");
    const w = await fixbug({ verifierKey: key, trusted: [publicOf(key)], inProcess: BOUNDARY_METHODS });
    await approvedThenCrashed(w, "vp10");
    expect((await w.rt.resume("vp10")).state).toBe("succeeded");
  });

  it("shows evidence made before the verifier had a process of its own as invalid once it has", async () => {
    const w = await world(FIXBUG, { tools: [new SimTool("git.open_pr")], agents: fixbugAgents() });
    expect((await approveOwner(w, "vp11")).state).toBe("succeeded");
    expect(await invalid(w, "vp11")).toEqual([]);
    const now = new Runtime(w.db, w.adapters, w.faults, undefined, { ...UNSIGNED, artifacts: w.rt.artifacts, signer: w.rt.signer, trustedVerifiers: new TrustedKeys([EvidenceSigner.generate().publicKeyPem()]) });
    // The static parts and the approval need no verifier; every check a verifier made does.
    expect((await now.verifyEvidence("vp11")).filter((e) => !e.valid).map((e) => e.criterion)).toEqual(["no_blocking_review", "regression_test", "suite_green"]);
  });

  it("counts each part of a criterion once: two parts of one method need two records", () => {
    expect(uncovered(["static", "review"], ["static"])).toEqual(["review"]);
    expect(uncovered(["test.suite", "test.suite"], ["test.suite"])).toEqual(["test.suite"]);
    expect(uncovered(["test.suite", "test.suite"], ["test.suite", "test.suite"])).toEqual([]);
    expect(uncovered(["static"], ["static", "static"])).toEqual([]);
  });

  it("knows from the configuration which methods it checks in its own process: boundary checks with a sandbox, onboarding checks", () => {
    const dir = mkdtempSync(join(tmpdir(), "mandate-vconf-"));
    const file = (name: string, c: object): string => {
      writeFileSync(join(dir, name), JSON.stringify({ database: "pglite:db", verifier: { workdir: ".", base: "seed", suites: {}, process: {} }, ...c }));
      return join(dir, name);
    };
    expect(inProcessMethods(readConfig(file("none.json", {})))).toEqual([]);
    expect(inProcessMethods(readConfig(file("nosandbox.json", { boundary: {} })))).toEqual([]);
    expect(inProcessMethods(readConfig(file("boundary.json", { boundary: {}, sandbox: { host: "mxc" } })))).toEqual([...BOUNDARY_METHODS]);
    expect(inProcessMethods(readConfig(file("both.json", { boundary: {}, sandbox: { host: "mxc" }, onboard: {} })))).toEqual([...BOUNDARY_METHODS, ...ONBOARD_METHODS]);
  });
});
