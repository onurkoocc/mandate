// Writes a fresh export of a real run, for a second verifier to check against this runtime's own (CI runs the Rust
// `verify-journal` on it). The run is made on an in-process PGlite database with a fresh evidence key, as the
// journal cases are (journal-cases.mjs), and one of its events holds pseudo-random data from a seed: doubles of every
// size, strings of code points from every plane, member names that sort differently by UTF-16 code units and by code
// points, nested a few levels. Another event comes after the run's last state change, so the tail is unanchored.
//
// It writes, into the directory given:
//   export.json            the export, as `mandate journal export` writes it
//   key.pem                the evidence key's public half, as `mandate journal key` writes it
//   report.json            this runtime's report of the export, as `mandate journal verify --json` prints it (verified)
//   tampered.json          the export with the random event's data changed in one value
//   tampered-report.json   this runtime's report of that (broken: chain_broken at that event)
//   tampered-seq           the seq of the changed event
//
//   npm run build && node runtime/scripts/journal-fresh.mjs <dir> [seed]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check } from "@mandate/bridge";
import { buildPackage, EvidenceSigner, openDb, Runtime, simulate, verifyExport } from "../dist/index.js";

const [dir, seedArg] = process.argv.slice(2);
if (!dir) throw new Error("usage: node runtime/scripts/journal-fresh.mjs <dir> [seed]");
const seed = seedArg === undefined ? BigInt.asUintN(64, BigInt(Date.now()) * 0x9e3779b97f4a7c15n) | 1n : BigInt(seedArg);
process.stdout.write(`seed ${seed}\n`);

// xorshift64*, from the seed, so a run that fails can be made again.
let state = BigInt.asUintN(64, seed) || 1n;
const next = () => {
  state ^= state >> 12n;
  state ^= BigInt.asUintN(64, state << 25n);
  state ^= state >> 27n;
  return BigInt.asUintN(64, state * 0x2545f4914f6cdd1dn);
};
const below = (n) => Number(next() % BigInt(n));
const view = new DataView(new ArrayBuffer(8));

/** A finite double: from random bits, or a short decimal, or an integer. */
function double() {
  switch (below(4)) {
    case 0: {
      for (;;) {
        view.setBigUint64(0, next());
        const x = view.getFloat64(0);
        if (Number.isFinite(x)) return x;
      }
    }
    case 1:
      return Number(`${below(2) ? "-" : ""}${1 + below(999999)}e${below(80) - 40}`);
    case 2:
      return below(2) ? below(1000) : -below(1e9) * 1000003;
    default:
      return [0, -0, 0.1, 1e21, 1e-7, 5e-324, 1.7976931348623157e308, 9007199254740993, 123456789012345680000][below(9)];
  }
}

/** A code point that a string the database stores may hold: not U+0000, not a surrogate. */
function codePoint() {
  const planes = [
    [0x01, 0x7f],
    [0x80, 0x7ff],
    [0x800, 0xd7ff],
    [0xe000, 0xffff],
    [0x10000, 0x10ffff],
  ];
  const [lo, hi] = planes[below(planes.length)];
  return lo + below(hi - lo + 1);
}

function string() {
  return String.fromCodePoint(...Array.from({ length: below(8) }, codePoint));
}

function value(depth) {
  const kind = depth >= 4 ? below(4) : below(6);
  if (kind === 0) return double();
  if (kind === 1) return string();
  if (kind === 2) return [null, true, false][below(3)];
  if (kind === 3) return double();
  if (kind === 4) return Array.from({ length: below(5) }, () => value(depth + 1));
  const o = {};
  for (let i = below(6); i > 0; i--) o[string()] = value(depth + 1);
  return o;
}

const data = { doubles: Array.from({ length: 64 }, double), strings: Array.from({ length: 32 }, string), nested: value(0) };
const names = {};
for (let i = 0; i < 24; i++) names[string()] = i;
data.names = names;

const PROGRAM = `mandate @ 0.2

module conformance.journal @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it?")
}
`;
const checked = check(PROGRAM, "mdt");
if (!checked.ok) throw new Error(`the program does not check: ${checked.diagnostics.map((d) => d.code).join(", ")}`);
const pkg = buildPackage(checked.program);

const db = await openDb();
try {
  const sim = simulate();
  const signer = EvidenceSigner.generate();
  const rt = new Runtime(db, sim.adapters, undefined, undefined, { signer, decisions: { mode: "unsigned" } });
  const runId = `fresh-${seed.toString(36)}`;
  const append = (type, d) =>
    db.tx(async (tx) => {
      await rt.journal.lock(tx, runId);
      await rt.journal.event(tx, runId, type, d);
    });

  const started = await rt.startRun({ pkg, workflow: "Ask", input: {}, runId });
  if (started.state !== "waiting") throw new Error(`the run is ${started.state}, not waiting`);
  sim.clock.advance(1250);
  await append("probe", data);
  const run = await rt.getRun(runId);
  const done = await rt.submitInput(runId, { sender: "ann", messageId: `${runId}-answer` }, { commandId: String(run.waiting.command), revision: run.revision, value: "yes" });
  if (done.state !== "succeeded") throw new Error(`the run is ${done.state}, not succeeded`);
  sim.clock.advance(250);
  // After the last state change: covered by no anchor, and normal.
  await append("probe", { after: "the run ended", at: double() });

  const x = await rt.exportJournal(runId);
  const text = JSON.stringify(x, null, 2) + "\n";
  const pem = signer.publicKeyPem();
  const report = verifyExport(Buffer.from(text), [pem]);
  if (report.status !== "verified") throw new Error(`the fresh export is ${report.status}: ${JSON.stringify(report.findings)}`);

  // Change one value of the random event's data, as someone who holds the file could.
  const probe = x.events.find((e) => e.type === "probe");
  probe.data.doubles[below(probe.data.doubles.length)] = 42.5;
  probe.data.doubles.push(1);
  const tampered = JSON.stringify(x, null, 2) + "\n";
  const broken = verifyExport(Buffer.from(tampered), [pem]);
  if (broken.status !== "broken" || !broken.findings.some((f) => f.code === "chain_broken" && f.seq === probe.seq)) {
    throw new Error(`the tampered export is not chain_broken at ${probe.seq}: ${JSON.stringify(broken.findings)}`);
  }

  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "export.json"), text);
  writeFileSync(join(dir, "key.pem"), pem);
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(dir, "tampered.json"), tampered);
  writeFileSync(join(dir, "tampered-report.json"), JSON.stringify(broken, null, 2) + "\n");
  writeFileSync(join(dir, "tampered-seq"), `${probe.seq}\n`);
  process.stdout.write(`run ${runId}: ${x.events.length} events, ${x.anchors.length} anchors; the event at seq ${probe.seq} changed in tampered.json\n`);
} finally {
  await db.close();
}
