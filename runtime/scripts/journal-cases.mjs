// Writes the journal conformance cases J01–J08 (conformance/README.md, spec/journal.md) from real runs on an
// in-process PGlite database. Each run gets a fresh evidence key, so the files differ every time this runs; the
// standing test is that the TypeScript verifier gives the committed report for the committed export and keys
// (runtime/test/journal-cases.test.ts). Only public keys are written. Some cases change the export's text after it
// was written, as someone holding the file could: J09 spells the same values otherwise, J13 and J14 move or repeat
// events, J15 is no export at all.
//
//   npm run build && node runtime/scripts/journal-cases.mjs [J09 J10 …]     (without ids: every case)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check } from "@mandate/compiler";
import { buildPackage, EvidenceSigner, EXPORT_LIMITS, openDb, Runtime, simulate, verifyExport } from "../dist/index.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "conformance");

// A 0.2 program whose person answers by name: the decisions are unsigned, so a case needs no member's key.
const PROGRAM = `mandate @ 0.2

module conformance.journal @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it? Ünïcödé 😀")
}
`;

const checked = check(PROGRAM, "mdt");
if (!checked.ok) throw new Error(`the cases' program does not check: ${checked.diagnostics.map((d) => d.code).join(", ")}`);
const pkg = buildPackage(checked.program);

/** A fresh database, clock and evidence key: one case's world. */
async function world() {
  const db = await openDb();
  const sim = simulate();
  const signer = EvidenceSigner.generate();
  const rt = new Runtime(db, sim.adapters, undefined, undefined, { signer, decisions: { mode: "unsigned" } });
  return { db, sim, signer, rt };
}

/** Starts the run, which waits for its answer. */
async function waiting(w, runId) {
  const run = await w.rt.startRun({ pkg, workflow: "Ask", input: {}, runId });
  if (run.state !== "waiting") throw new Error(`${runId} is ${run.state}, not waiting`);
  w.sim.clock.advance(1250);
}

/** Answers it, so it succeeds. */
async function answered(w, runId, sender = "ann") {
  const run = await w.rt.getRun(runId);
  const done = await w.rt.submitInput(runId, { sender, messageId: `${runId}-answer` }, { commandId: String(run.waiting.command), revision: run.revision, value: "yes" });
  if (done.state !== "succeeded") throw new Error(`${runId} is ${done.state}, not succeeded`);
  w.sim.clock.advance(250);
}

/** Appends an event as the runtime appends any: under the run's row lock. */
async function append(w, runId, type, data) {
  await w.db.tx(async (tx) => {
    await w.rt.journal.lock(tx, runId);
    await w.rt.journal.event(tx, runId, type, data);
  });
}

/** Values whose canonical form a second implementation must print exactly as ECMAScript does. */
const EDGES = {
  numbers: [0, -0, 1, -1, 0.1, 0.5, 1 / 3, 1e21, 1e-7, 123456789012345680000, 5e-324, 1.7976931348623157e308, -2.5e-8, 9007199254740991, 9007199254740993, 1e300],
  strings: ["", "é", "e\u0301", "😀", "\u2028", "quote \" backslash \\ slash / tab \t newline \n", String.fromCharCode(0x7f, 0x1f)],
  order: { [String.fromCharCode(0xffff)]: "U+FFFF sorts after an astral character by UTF-16 code units", "😀": "an astral character", a: 1, B: 2, "": 0, aa: [], z: {} },
};

const CASES = [
  {
    id: "J01",
    title: "A closed run whose chain holds and whose anchors cover every event verifies, also over data with fractions, exponents, escapes and keys that sort differently by UTF-16 code units and by code points.",
    status: "verified",
    async make(w) {
      await waiting(w, "j01");
      await append(w, "j01", "probe", EDGES);
      await answered(w, "j01", "Ünal 😀");
    },
  },
  {
    id: "J02",
    title: "An event whose data was edited in the database breaks the chain at that event.",
    status: "broken",
    async make(w) {
      await waiting(w, "j02");
      await answered(w, "j02");
      await w.db.query(`update events set data = jsonb_set(data, '{sender}', '"mallory"') where run_id = 'j02' and type = 'input_received'`);
    },
  },
  {
    id: "J03",
    title: "An event deleted from the database leaves a gap in the seqs and breaks the chain at the event after it.",
    status: "broken",
    async make(w) {
      await waiting(w, "j03");
      await answered(w, "j03");
      await w.db.query("delete from events where run_id = 'j03' and type = 'input_received'");
    },
  },
  {
    id: "J04",
    title: "A tail cut from the database while its anchors stay names events past the last one.",
    status: "broken",
    async make(w) {
      await waiting(w, "j04");
      await answered(w, "j04");
      await w.db.query("delete from events where run_id = 'j04' and seq > 6");
    },
  },
  {
    id: "J05",
    title: "An open run with events after its last anchor verifies, and the report says no signature covers them.",
    status: "verified",
    async make(w) {
      await waiting(w, "j05");
      // A worker took the lease and stopped before it set the run's state.
      await w.rt.journal.acquire("j05");
    },
  },
  {
    id: "J06",
    title: "An anchor signed by a key the verifier is not given, and one whose signature does not verify, are refused.",
    status: "broken",
    async make(w) {
      await waiting(w, "j06");
      await answered(w, "j06");
      const anchors = await w.db.query("select seq, hash, at, signature from journal_anchors where run_id = 'j06' order by seq");
      const last = anchors[anchors.length - 1];
      const forged = EvidenceSigner.generate().signStatement("mandate/journal-anchor/0.1", { format: "mandate/journal-anchor/0.1", run: "j06", seq: Number(last.seq), hash: last.hash, at: Number(last.at) });
      await w.db.query("update journal_anchors set key_id = $1, signature = $2 where run_id = 'j06' and seq = $3", [forged.key_id, forged.signature, last.seq]);
      // Another signature of the same length: the first character of the base64 changed.
      const second = anchors[1];
      const b64 = second.signature.slice("ed25519:".length);
      await w.db.query("update journal_anchors set signature = $1 where run_id = 'j06' and seq = $2", [`ed25519:${b64[0] === "A" ? "B" : "A"}${b64.slice(1)}`, second.seq]);
    },
  },
  {
    id: "J07",
    title: "A manifest and a package edited in the database are not the ones the first event names.",
    status: "broken",
    async make(w) {
      await waiting(w, "j07");
      await answered(w, "j07");
      await w.db.query(`update runs set manifest = jsonb_set(manifest, '{mode}', '"design"') where run_id = 'j07'`);
      await w.db.query(`update packages set lock = jsonb_set(lock, '{modules}', '{"company.domain": "sha256:0f1e"}')`);
    },
  },
  {
    id: "J08",
    title: "A run begun before the journal was chained has no hash and no anchor, and is reported unchained, never verified or broken.",
    status: "unchained",
    async make(w) {
      await waiting(w, "j08");
      // As a run written before the chain: then it goes on, and its new events get no hash either.
      await w.db.query("update events set hash = null where run_id = 'j08'");
      await w.db.query("delete from journal_anchors where run_id = 'j08'");
      await answered(w, "j08");
    },
  },
];

/** Writes a value with its members in reverse order and tabs, as another writer of the same JSON might. */
function respelled(v) {
  if (Array.isArray(v)) return v.map(respelled);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).reverse().map((k) => [k, respelled(v[k])]));
  return v;
}

/** Replaces `from` once in `text`; a spelling the case relies on must be there. */
function once(text, from, to) {
  if (!text.includes(from)) throw new Error(`J09: no ${from} in the export`);
  return text.replace(from, to);
}

/** The anchors of a run, by seq. */
async function anchorRows(w, runId) {
  return w.db.query("select seq, hash, at from journal_anchors where run_id = $1 order by seq", [runId]);
}

CASES.push(
  {
    id: "J09",
    title: "An export whose text spells the same values otherwise (exponents, trailing zeros, -0, a number below the smallest double, escapes, member order, white space) verifies: the verifier hashes values, not their spelling.",
    status: "verified",
    async make(w) {
      await waiting(w, "j09");
      await append(w, "j09", "probe", { j09_zero: 0, j09_negzero: 0, j09_tenth: 0.1, j09_big: 1e21, j09_one: 1, j09_e: "\u00e9", j09_slash: "a/b" });
      await answered(w, "j09");
    },
    respell(x) {
      let text = JSON.stringify(respelled(x), null, "\t") + "\n";
      text = once(text, '"j09_zero": 0', '"j09_zero": 1e-400');
      text = once(text, '"j09_negzero": 0', '"j09_negzero": -0');
      text = once(text, '"j09_tenth": 0.1', '"j09_tenth": 0.10');
      text = once(text, '"j09_big": 1e+21', '"j09_big": 1E21');
      text = once(text, '"j09_one": 1', '"j09_one": 1.0e0');
      text = once(text, '"j09_e": "\u00e9"', '"j09_e": "\\u00e9"');
      text = once(text, '"j09_slash": "a/b"', '"j09_slash": "a\\/b"');
      // The first seq 1 and the first time in the text, whichever object they are in: the value is the same.
      if (!/"seq": 1(?=\s)/.test(text)) throw new Error("J09: no seq 1");
      text = text.replace(/"seq": 1(?=\s)/, '"seq": 1.0');
      const at = x.events[0].at;
      text = once(text, `"at": ${at}`, `"at": ${at / 10}e1`);
      return text.replaceAll('": ', '":  ');
    },
  },
  {
    id: "J10",
    title: "An event of a chained run whose hash was removed in the database is hash_missing, and breaks the chain at the event after it.",
    status: "broken",
    async make(w) {
      await waiting(w, "j10");
      await answered(w, "j10");
      await w.db.query("update events set hash = null where run_id = 'j10' and type = 'wait_opened'");
    },
  },
  {
    id: "J11",
    title: "An anchor signed by the runtime's key over a hash its event does not have is anchor_mismatch, however its signature holds.",
    status: "broken",
    async make(w) {
      await waiting(w, "j11");
      await answered(w, "j11");
      const [a] = (await anchorRows(w, "j11")).filter((r) => Number(r.seq) === 5);
      const [other] = await w.db.query("select hash from events where run_id = 'j11' and seq = 4");
      const sig = w.signer.signStatement("mandate/journal-anchor/0.1", { format: "mandate/journal-anchor/0.1", run: "j11", seq: 5, hash: other.hash, at: Number(a.at) });
      await w.db.query("update journal_anchors set hash = $1, signature = $2 where run_id = 'j11' and seq = 5", [other.hash, sig.signature]);
    },
  },
  {
    id: "J12",
    title: "A state event whose anchor was removed from the database is anchor_missing, and the run is broken, not clean.",
    status: "broken",
    async make(w) {
      await waiting(w, "j12");
      await answered(w, "j12");
      await w.db.query("delete from journal_anchors where run_id = 'j12' and seq = 5");
    },
  },
  {
    id: "J13",
    title: "Events moved in the export, seqs [1, 2, 5, 3, 4, …]: the first misplaced position is seq_gap, and an anchor names the first event with its seq in the export's order.",
    status: "broken",
    async make(w) {
      await waiting(w, "j13");
      await answered(w, "j13");
    },
    respell(x) {
      const [e1, e2, e3, e4, e5, ...rest] = x.events;
      return JSON.stringify({ ...x, events: [e1, e2, e5, e3, e4, ...rest] }, null, 2) + "\n";
    },
  },
  {
    id: "J14",
    title: "A second event with the last seq, after the genuine one: the anchor names the first in the export's order, which holds, and the copy is seq_gap and chain_broken.",
    status: "broken",
    async make(w) {
      await waiting(w, "j14");
      await answered(w, "j14");
    },
    respell(x) {
      const last = x.events[x.events.length - 1];
      return JSON.stringify({ ...x, events: [...x.events, { ...last, data: { forged: true } }] }, null, 2) + "\n";
    },
  },
  {
    id: "J15",
    title: "An export with a duplicate member is unreadable, malformed_export: nothing is said about the journal.",
    status: "unreadable",
    async make(w) {
      await waiting(w, "j15");
      await answered(w, "j15");
    },
    respell(x) {
      return once(JSON.stringify(x, null, 2) + "\n", '"tenant": "default"', '"tenant": "default",\n  "tenant": "default"');
    },
  },
  {
    id: "J16",
    title: "A run whose event data nests deeper than every verifier reads is journaled as any other, and its export is unreadable, export_over_limit.",
    status: "unreadable",
    async make(w) {
      await waiting(w, "j16");
      let deep = [];
      for (let i = 0; i < EXPORT_LIMITS.depth; i++) deep = [deep];
      await append(w, "j16", "probe", { deep });
      await answered(w, "j16");
    },
  },
);

const only = process.argv.slice(2);
for (const c of CASES) {
  if (only.length && !only.includes(c.id)) continue;
  const w = await world();
  try {
    await c.make(w);
    const x = await w.rt.exportJournal(c.id.toLowerCase());
    const text = c.respell ? c.respell(x) : JSON.stringify(x, null, 2) + "\n";
    const pem = w.signer.publicKeyPem();
    const report = verifyExport(Buffer.from(text), [pem]);
    if (report.status !== c.status) throw new Error(`${c.id} is ${report.status}, and the case says ${c.status}: ${JSON.stringify(report.findings)}`);
    const dir = join(root, c.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "export.json"), text);
    writeFileSync(join(dir, "key.pem"), pem);
    writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    const kase = {
      $schema: "../case.schema.json",
      format: "mandate/conformance-case/0.1",
      id: c.id,
      kind: "journal",
      title: c.title,
      spec: ["spec/journal.md#verification", "spec/journal.md#conformance-cases"],
      journal: { export: "export.json", keys: ["key.pem"], report: "report.json" },
    };
    writeFileSync(join(dir, "case.json"), JSON.stringify(kase, null, 2) + "\n");
    process.stdout.write(`${c.id} ${report.status} ${report.findings.map((f) => (f.seq !== undefined ? `${f.code}@${f.seq}` : f.code)).join(" ")}\n`);
  } finally {
    await w.db.close();
  }
}
