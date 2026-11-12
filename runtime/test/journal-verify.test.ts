// Verifying a run's journal from its export and public keys alone
// (spec/journal.md "Verification"). Each test changes the database as someone
// who holds it but not the key could, exports the run again, and reads the
// report. Replay and the views never check the chain: they behave on a
// tampered journal as before (the tests that edit and delete events in
// plan.test.ts, map.test.ts and views-envelope.test.ts show it).

import { generateKeyPairSync } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { EvidenceSigner } from "../src/evidence.js";
import { ANCHOR_FORMAT, anchorStatement, eventHash, EXPORT_LIMITS, parseExportJson, publicKeysIn, verifyExport, type JournalExport, type JournalReport } from "../src/journal-chain.js";
import { Crash } from "../src/signals.js";
import { canonical, digest, type Value } from "../src/values.js";
import { runView } from "../src/views.js";
import { closeAll, start, world, type World } from "./helpers.js";
import { ASK, FIX } from "./programs.js";

afterAll(closeAll);

/** A run that waited for an answer and succeeded: nine events, five of them state events, each anchored. */
async function closed(runId: string): Promise<World> {
  return closedIn(await world(ASK), runId);
}

/** Another such run in the same world: a new world empties the database. */
async function closedIn(w: World, runId: string): Promise<World> {
  await start(w, "Ask", runId);
  const run = await w.rt.getRun(runId);
  const done = await w.rt.submitInput(runId, { sender: "ann", messageId: `m-${runId}` }, { commandId: String((run.waiting as { command: string }).command), revision: run.revision, value: "yes" });
  expect(done.state).toBe("succeeded");
  return w;
}

const verify = async (w: World, runId: string): Promise<JournalReport> => verifyExport(JSON.stringify(await w.rt.exportJournal(runId)), w.rt.trusted.publicKeys());
const codes = (r: JournalReport): string[] => r.findings.map((f) => (f.seq !== undefined ? `${f.code}@${f.seq}` : f.code));
const seqOf = async (w: World, runId: string, type: string): Promise<number> => (await w.rt.journal.events(runId)).find((e) => e.type === type)!.seq;

describe("a journal export (spec/journal.md)", () => {
  it("carries the events with their time and hash, the anchors, the manifest and the package the first event names", async () => {
    const w = await closed("x1");
    const x = await w.rt.exportJournal("x1");
    const run = await w.rt.getRun("x1");
    expect(Object.keys(x)).toEqual(["format", "run", "tenant", "manifest_hash", "manifest", "package", "events", "anchors", "keys"]);
    expect(x).toMatchObject({ format: "mandate/journal-export/0.1", run: "x1", tenant: "default", manifest_hash: run.manifest_hash, manifest: run.manifest, keys: [w.rt.signer.keyId] });
    expect(x.package).toEqual({ hash: w.pkg.hash, program: JSON.parse(JSON.stringify(w.pkg.program)), lock: w.pkg.lock, modules: {} });
    expect(x.events.map((e) => e.type)).toEqual((await w.rt.journal.events("x1")).map((e) => e.type));
    expect(x.events.every((e) => typeof e.at === "number" && /^sha256:[0-9a-f]{64}$/.test(e.hash ?? ""))).toBe(true);
    expect(x.anchors.map((a) => a.seq)).toEqual(x.events.filter((e) => e.type.startsWith("run_")).map((e) => e.seq));
    // No decision or evidence record travels with it.
    expect(JSON.stringify(x)).not.toContain('"evidence_id"');
  });
});

describe("verifying a journal (spec/journal.md)", () => {
  it("verifies a closed run: the chain holds and the signatures cover every event", async () => {
    const w = await closed("v1");
    const r = await w.rt.verifyJournal("v1");
    expect(r).toEqual({ format: "mandate/journal-verification/0.1", run: "v1", status: "verified", events: 9, last_seq: 9, anchored_through: 9, unanchored: 0, signed_by: [w.rt.signer.keyId], findings: [] });
    expect(await verify(w, "v1")).toEqual(r);
  });

  it("breaks at an event whose data was edited, and at none before it", async () => {
    const w = await closed("v2");
    await w.db.query("update events set data = jsonb_set(data, '{kind}', '\"edited\"') where run_id = 'v2' and type = 'wait_opened'");
    const r = await verify(w, "v2");
    expect(r.status).toBe("broken");
    expect(codes(r)).toEqual([`chain_broken@${await seqOf(w, "v2", "wait_opened")}`]);
  });

  it("breaks at an event whose type or time was edited", async () => {
    const w = await closed("v3");
    const lease = await seqOf(w, "v3", "lease_acquired");
    await w.db.query("update events set type = 'lease_taken' where run_id = 'v3' and seq = $1", [lease]);
    expect(codes(await verify(w, "v3"))).toEqual([`chain_broken@${lease}`]);
    await w.db.query("update events set type = 'lease_acquired', at = at + 1 where run_id = 'v3' and seq = $1", [lease]);
    expect(codes(await verify(w, "v3"))).toEqual([`chain_broken@${lease}`]);
  });

  it("catches a chain rewritten from an edit on: the anchors no longer name those hashes", async () => {
    const w = await closed("v4");
    const x = await w.rt.exportJournal("v4");
    const k = x.events.findIndex((e) => e.type === "wait_opened");
    x.events[k]!.data = { ...(x.events[k]!.data as Record<string, Value>), kind: "edited" };
    for (let i = k; i < x.events.length; i++) {
      const e = x.events[i]!;
      e.hash = eventHash({ run: "v4", seq: e.seq, type: e.type, data: e.data, at: e.at, prev: x.events[i - 1]!.hash });
    }
    const r = verifyExport(JSON.stringify(x), w.rt.trusted.publicKeys());
    expect(r.status).toBe("broken");
    expect(codes(r)).toEqual([...x.anchors.filter((a) => a.seq > k + 1).map((a) => `anchor_mismatch@${a.seq}`), `unanchored_tail@${k + 1}`]);
    // An anchor moved to the new hash is no longer what was signed.
    for (const a of x.anchors) a.hash = x.events.find((e) => e.seq === a.seq)!.hash!;
    expect(codes(verifyExport(JSON.stringify(x), w.rt.trusted.publicKeys()))).toEqual([...x.anchors.filter((a) => a.seq > k + 1).map((a) => `anchor_signature_invalid@${a.seq}`), `unanchored_tail@${k + 1}`]);
  });

  it("breaks where an event was deleted", async () => {
    const w = await closed("v5");
    const lease = await seqOf(w, "v5", "lease_acquired");
    await w.db.query("delete from events where run_id = 'v5' and seq = $1", [lease]);
    expect(codes(await verify(w, "v5"))).toEqual([`seq_gap@${lease}`, `chain_broken@${lease + 1}`]);
  });

  it("breaks where two events were swapped", async () => {
    const w = await closed("v6");
    const a = await seqOf(w, "v6", "lease_acquired");
    await w.db.query("update events set seq = -1 where run_id = 'v6' and seq = $1", [a]);
    await w.db.query("update events set seq = $1 where run_id = 'v6' and seq = $2", [a, a + 1]);
    await w.db.query("update events set seq = $1 where run_id = 'v6' and seq = -1", [a + 1]);
    // The run_running event now stands at the lease's place, without its anchor; the anchor at its old place names another hash.
    expect(codes(await verify(w, "v6"))).toEqual([`chain_broken@${a}`, `chain_broken@${a + 1}`, `chain_broken@${a + 2}`, `anchor_mismatch@${a + 1}`, `anchor_missing@${a}`]);
  });

  it("breaks where the tail was cut past an anchor", async () => {
    const w = await closed("v7");
    await w.db.query("delete from events where run_id = 'v7' and seq >= 8");
    // The last two state events went with it; their anchors stayed. What is left is signed through seq 5.
    const r = await verify(w, "v7");
    expect(codes(r)).toEqual(["anchor_beyond_end@8", "anchor_beyond_end@9", "unanchored_tail@6"]);
    expect([r.status, r.anchored_through]).toEqual(["broken", 5]);
    // Cut together with their anchors, the tail is gone without a trace in the database: the limit spec/journal.md states.
    await w.db.query("delete from journal_anchors where run_id = 'v7' and seq >= 8");
    expect(await verify(w, "v7")).toMatchObject({ status: "verified", anchored_through: 5, unanchored: 2, findings: [{ code: "unanchored_tail", seq: 6 }] });
  });

  it("does not let a removed anchor make a run clean: every state event has one", async () => {
    const w = await closed("v8");
    await w.db.query("delete from journal_anchors where run_id = 'v8' and seq = 9");
    expect(codes(await verify(w, "v8"))).toEqual(["anchor_missing@9", "unanchored_tail@9"]);
    await w.db.query("delete from journal_anchors where run_id = 'v8'");
    const r = await verify(w, "v8");
    expect(r.status).toBe("broken");
    expect(r.anchored_through).toBeNull();
    expect(codes(r)).toEqual(["anchor_missing@1", "anchor_missing@3", "anchor_missing@5", "anchor_missing@8", "anchor_missing@9", "unanchored_tail@1"]);
  });

  it("refuses an anchor forged with a key not given, and one whose signature does not verify", async () => {
    const w = await closed("v9");
    const forger = EvidenceSigner.generate();
    const [a] = await w.db.query<{ hash: string; at: unknown }>("select hash, at from journal_anchors where run_id = 'v9' and seq = 9");
    const forged = forger.signStatement(ANCHOR_FORMAT, anchorStatement("v9", 9, a!.hash, Number(a!.at)));
    await w.db.query("update journal_anchors set key_id = $1, signature = $2 where run_id = 'v9' and seq = 9", [forged.key_id, forged.signature]);
    expect(codes(await verify(w, "v9"))).toEqual(["anchor_unknown_key@9", "unanchored_tail@9"]);
    // Under the forger's key too it holds; the report names whose signature covers what.
    const both = verifyExport(JSON.stringify(await w.rt.exportJournal("v9")), [...w.rt.trusted.publicKeys(), forger.publicKey]);
    expect([both.status, both.signed_by.sort()]).toEqual(["verified", [forger.keyId, w.rt.signer.keyId].sort()]);
    // The runtime's own key over another statement: not a signature of this anchor.
    const other = w.rt.signer.signStatement(ANCHOR_FORMAT, anchorStatement("v9", 9, a!.hash, Number(a!.at) + 1));
    await w.db.query("update journal_anchors set key_id = $1, signature = $2 where run_id = 'v9' and seq = 9", [other.key_id, other.signature]);
    expect(codes(await verify(w, "v9"))).toEqual(["anchor_signature_invalid@9", "unanchored_tail@9"]);
  });

  it("refuses a signature that is not the canonical base64 of 64 bytes", async () => {
    const w = await closed("v10");
    const x = await w.rt.exportJournal("v10");
    const good = x.anchors[0]!.signature;
    const b64 = good.slice("ed25519:".length);
    // The same bytes with the unused bits of the last character set: Node would decode it, a strict decoder would not.
    const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const loose = `ed25519:${b64.slice(0, 85)}${ALPHABET[ALPHABET.indexOf(b64[85]!) ^ 1]}==`;
    expect(Buffer.from(loose.slice(8), "base64")).toEqual(Buffer.from(b64, "base64"));
    for (const sig of [`${good}=`, good.replace("ed25519:", "ED25519:"), `ed25519:${b64.slice(0, 84)}==`, loose]) {
      x.anchors[0]!.signature = sig;
      expect(codes(verifyExport(JSON.stringify(x), w.rt.trusted.publicKeys()))[0]).toBe("anchor_signature_invalid@1");
    }
  });

  it("breaks on an anchor whose hash or time is not its event's", async () => {
    const w = await closed("v11");
    const x = await w.rt.exportJournal("v11");
    const [a1, a2] = [x.anchors[1]!, x.anchors[2]!];
    a1.hash = x.events[0]!.hash!;
    // An anchor the key did sign, over another time than its event's: it signs nothing the journal holds.
    Object.assign(a2, { at: a2.at + 1 }, w.rt.signer.signStatement(ANCHOR_FORMAT, anchorStatement("v11", a2.seq, a2.hash, a2.at + 1)));
    expect(codes(verifyExport(JSON.stringify(x), w.rt.trusted.publicKeys()))).toEqual([`anchor_signature_invalid@${a1.seq}`, `anchor_mismatch@${a1.seq}`, `anchor_mismatch@${a2.seq}`]);
  });

  it("breaks when the manifest or the package is not the one the first event names", async () => {
    const w = await closed("v12");
    await closedIn(w, "v12b");
    await w.db.query("update runs set manifest = jsonb_set(manifest, '{mode}', '\"design\"') where run_id = 'v12'");
    expect(codes(await verify(w, "v12"))).toEqual(["manifest_mismatch"]);
    // A manifest with a hash of its own: not the one this run's first event names.
    const x = await w.rt.exportJournal("v12b");
    const manifest = { ...(x.manifest as Record<string, Value>), mode: "design" };
    expect(codes(verifyExport(JSON.stringify({ ...x, manifest, manifest_hash: digest("run", manifest) }), w.rt.trusted.publicKeys()))).toEqual(["manifest_mismatch"]);
    const y = await w.rt.exportJournal("v12b");
    expect(codes(verifyExport(JSON.stringify(y), w.rt.trusted.publicKeys()))).toEqual([]);
    expect(codes(verifyExport(JSON.stringify({ ...y, tenant: "other" }), w.rt.trusted.publicKeys()))).toEqual(["manifest_mismatch"]);
    (y.package.lock as { modules: Record<string, string> }).modules["company.domain"] = "sha256:0f1f";
    expect(codes(verifyExport(JSON.stringify(y), w.rt.trusted.publicKeys()))).toEqual(["package_mismatch"]);
    const z = await w.rt.exportJournal("v12b");
    (z.package.program as { module: string }).module = "test.other";
    expect(codes(verifyExport(JSON.stringify(z), w.rt.trusted.publicKeys()))).toEqual(["package_mismatch"]);
    const m = await w.rt.exportJournal("v12b");
    (m.package.modules as Record<string, Value>)["company.domain"] = { language: "mandate/0.1", module: "company.domain", defs: {} };
    expect(codes(verifyExport(JSON.stringify(m), w.rt.trusted.publicKeys()))).toEqual(["package_mismatch"]);
  });

  it("verifies an open run with events after its last anchor, and says no signature covers them", async () => {
    const w = await world(FIX);
    w.faults.arm("after_record", (i) => i.kind === "delegate");
    await expect(start(w, "Fix", "open")).rejects.toBeInstanceOf(Crash);
    const r = await w.rt.verifyJournal("open");
    const running = await seqOf(w, "open", "run_running");
    expect(r).toMatchObject({ status: "verified", anchored_through: running, unanchored: r.events - running, findings: [{ code: "unanchored_tail", seq: running + 1 }] });
    expect(r.unanchored).toBeGreaterThan(0);
    // The run goes on; its next state change anchors what came before it.
    expect((await w.rt.resume("open")).state).toBe("succeeded");
    expect(await w.rt.verifyJournal("open")).toMatchObject({ status: "verified", unanchored: 0, findings: [] });
  });

  it("verifies the events written after a run ended, as an unanchored tail", async () => {
    const w = await closed("v13");
    // A worker that comes to a finished run takes its lease before it sees the run has ended.
    await w.rt.resume("v13");
    expect(codes(await verify(w, "v13"))).toEqual(["unanchored_tail@10"]);
    expect((await verify(w, "v13")).status).toBe("verified");
  });

  it("reports a run begun before the chain as unchained, and one stripped of its first hash as broken", async () => {
    const w = await closed("v14");
    await w.db.query("update events set hash = null where run_id = 'v14'");
    await w.db.query("delete from journal_anchors where run_id = 'v14'");
    expect(await verify(w, "v14")).toEqual({ format: "mandate/journal-verification/0.1", run: "v14", status: "unchained", events: 9, last_seq: 9, anchored_through: null, unanchored: 9, signed_by: [], findings: [] });
    const v = await closed("v15");
    await v.db.query("update events set hash = null where run_id = 'v15' and seq = 1");
    expect(codes(await verify(v, "v15"))).toEqual(["hash_missing@1", "chain_broken@2", "anchor_mismatch@1"]);
    // Every hash stripped and the anchors left: still a chained run, and broken, not unchained.
    await v.db.query("update events set hash = null where run_id = 'v15'");
    const stripped = await verify(v, "v15");
    expect(stripped.status).toBe("broken");
    expect(codes(stripped).filter((c) => c.startsWith("hash_missing"))).toHaveLength(9);
  });

  it("reads an export strictly, and anything it cannot read is malformed_export", async () => {
    const w = await closed("v16");
    const text = JSON.stringify(await w.rt.exportJournal("v16"));
    const keys = w.rt.trusted.publicKeys();
    const malformed = { format: "mandate/journal-verification/0.1", run: null, status: "broken", events: 0, last_seq: null, anchored_through: null, unanchored: 0, signed_by: [], findings: [{ code: "malformed_export" }] };
    const bs = "\\";
    for (const bad of [
      text.slice(0, -1),
      `${text} {}`,
      text.replace('"tenant":"default"', '"tenant":"default","tenant":"default"'),
      text.replace('"format":"mandate/journal-export/0.1"', '"format":"mandate/journal-export/0.2"'),
      text.replace('"keys":[', '"extra":1,"keys":['),
      text.replace('"tenant":"default"', '"tenant":1'),
      text.replace(/"seq":1,/, '"seq":1.5,'),
      text.replace(/"at":(\d+)/, '"at":1e400'),
      text.replace('"tenant":"default"', `"tenant":"${bs}ud800"`),
      text.replace('"tenant":"default"', `"tenant":"${bs}udc00x"`),
      text.replace('"tenant":"default"', `"tenant":"${bs}x"`),
      text.replace('"tenant":"default"', '"tenant":"a\tb"'),
      text.replace('"events":[', '"events":[ ]').replace(/"events":\[ \][\s\S]*?\],"anchors"/, '"events":[],"anchors"'),
    ]) {
      expect(verifyExport(bad, keys), bad.slice(0, 80)).toEqual(malformed);
    }
    expect(verifyExport(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), keys)).toEqual(malformed);
    expect(verifyExport(Buffer.concat([Buffer.from(text.slice(0, 20)), Buffer.from([0xc3, 0x28]), Buffer.from(text.slice(20))]), keys)).toEqual(malformed);
    expect(verifyExport(Buffer.from(text), keys).status).toBe("verified");
  });

  it("reads numbers as JSON.parse does, and refuses nesting past its limit", () => {
    const bs = "\\";
    expect(parseExportJson('{"a":[1.5,-0,1e21,5e-324,0.1],"__proto__":{"x":1},"s":"' + bs + "ud83d" + bs + 'ude00"}')).toEqual({ ok: true, value: JSON.parse('{"a":[1.5,-0,1e21,5e-324,0.1],"__proto__":{"x":1},"s":"' + bs + "ud83d" + bs + 'ude00"}') });
    const parsed = parseExportJson('{"__proto__":{"x":1}}');
    expect(parsed.ok && Object.keys(parsed.value as object)).toEqual(["__proto__"]);
    expect(canonical((parseExportJson("[-0]") as { value: Value }).value)).toBe("[0]");
    expect(parseExportJson("[".repeat(EXPORT_LIMITS.depth) + "]".repeat(EXPORT_LIMITS.depth)).ok).toBe(true);
    expect(parseExportJson("[".repeat(EXPORT_LIMITS.depth + 1) + "]".repeat(EXPORT_LIMITS.depth + 1)).ok).toBe(false);
    for (const bad of ["01", "1.", ".5", "+1", "1e", "NaN", "[1,]", '{"a":1,}', "tru", "'a'", "[1] x", String.fromCharCode(34, 1, 34)]) expect(parseExportJson(bad).ok, bad).toBe(false);
  });

  it("reads every ed25519 public key in a PEM file, and refuses another kind", () => {
    const a = EvidenceSigner.generate();
    const b = EvidenceSigner.generate();
    expect(publicKeysIn(a.publicKeyPem() + b.publicKeyPem()).map((k) => k.export({ type: "spki", format: "pem" }))).toEqual([a.publicKeyPem(), b.publicKeyPem()]);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ type: "spki", format: "pem" }) as string;
    expect(() => publicKeysIn(rsa)).toThrow(/ed25519/);
  });

  it("leaves replay and the views as they were on a tampered journal", async () => {
    const w = await closed("v17");
    const before = await w.rt.replayRun("v17");
    await w.db.query("update events set at = at + 5 where run_id = 'v17'");
    await w.db.query("delete from journal_anchors where run_id = 'v17'");
    expect((await w.rt.verifyJournal("v17")).status).toBe("broken");
    expect(await w.rt.replayRun("v17")).toEqual(before);
    expect((await runView(w.rt, "v17")).view.run).toMatchObject({ id: "v17", state: "succeeded" });
  });

  it("is a function of the export and the keys: what the runtime reports is what an outsider reports", async () => {
    const w = await closed("v18");
    const x: JournalExport = await w.rt.exportJournal("v18");
    const pems = w.rt.trusted.publicKeys().map((k) => k.export({ type: "spki", format: "pem" }) as string);
    expect(verifyExport(Buffer.from(JSON.stringify(x, null, 2)), pems)).toEqual(await w.rt.verifyJournal("v18"));
  });
});
