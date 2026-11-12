// `mandate journal export | key | verify` (spec/journal.md): a run's journal
// is exported from the database, the public keys from the configuration, and
// the export is verified from those files alone.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { openDb } from "../src/db.js";
import type { JournalExport, JournalReport } from "../src/journal-chain.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-journal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, "ask.mdt"),
  `mandate @ 0.2

module cli.journal @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it?")
}
`,
);
writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" } }));

/** One CLI call; `config: false` runs it with no configuration anywhere. */
async function mandate(args: string[], config = true): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main(config ? [...args, "--config", join(dir, "mandate.runtime.json")] : [...args, "--config", join(dir, "none.json")], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

const file = (name: string): string => join(dir, name);

describe("mandate journal (spec/journal.md)", () => {
  it("exports a run, writes the keys, and verifies the export from those files alone", async () => {
    const started = await mandate(["run", file("ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "j1"]);
    expect(started.code, started.err).toBe(0);
    const revision = started.out.match(/revision (\d+)/)![1]!;
    expect((await mandate(["answer", "j1", "--revision", revision, "--by", "ann", "yes"])).out).toContain("succeeded");

    const exported = await mandate(["journal", "export", "j1", "--out", file("j1.json")]);
    expect(exported.code, exported.err).toBe(0);
    expect(exported.out).toMatch(/^run j1: 9 events, 5 anchors, written to /);
    const x = JSON.parse(readFileSync(file("j1.json"), "utf8")) as JournalExport;
    expect(x.format).toBe("mandate/journal-export/0.1");
    // Without --out the export is the command's output, the same document.
    expect(JSON.parse((await mandate(["journal", "export", "j1"])).out)).toEqual(x);

    const key = await mandate(["journal", "key", "--out", file("cp.pub.pem")]);
    expect(key.code, key.err).toBe(0);
    expect(key.out).toMatch(/^1 key written to .*: sha256:[0-9a-f]{64} \(sha256:[0-9a-f]{64} signs now\)/);
    expect(x.keys).toEqual([key.out.match(/: (sha256:[0-9a-f]{64})/)![1]]);
    expect(readFileSync(file("cp.pub.pem"), "utf8")).toMatch(/^-----BEGIN PUBLIC KEY-----\n[\s\S]+-----END PUBLIC KEY-----\n$/);
    expect(readFileSync(file("cp.pub.pem"), "utf8")).not.toContain("PRIVATE");

    // No configuration and no database: the export and the key file only.
    const ok = await mandate(["journal", "verify", file("j1.json"), "--key", file("cp.pub.pem")], false);
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toBe(`verified: run j1, 9 events\n  signed through seq 9 by ${x.keys[0]}; 0 events after it covered by no signature\n`);
    const report = JSON.parse((await mandate(["journal", "verify", file("j1.json"), "--key", file("cp.pub.pem"), "--json"], false)).out) as JournalReport;
    expect(report).toMatchObject({ format: "mandate/journal-verification/0.1", status: "verified", anchored_through: 9, findings: [] });
  });

  it("says where a journal edited in the database breaks, and exits 1", async () => {
    const db = await openDb(`pglite:${file("db")}`);
    try {
      await db.query("update events set data = jsonb_set(data, '{kind}', '\"edited\"') where run_id = 'j1' and seq = 4");
    } finally {
      await db.close();
    }
    expect((await mandate(["journal", "export", "j1", "--out", file("j1-edited.json")])).code).toBe(0);
    const broken = await mandate(["journal", "verify", file("j1-edited.json"), "--key", file("cp.pub.pem")], false);
    expect(broken.code).toBe(1);
    expect(broken.out).toContain("broken: run j1, 9 events\n  chain_broken at seq 4: ");
    // The anchors still hold, but the events under them are not what was signed: no reach is claimed.
    expect(broken.out).not.toContain("signed through");
  });

  it("verifies under the rotated-out key too, once journal key writes it", async () => {
    expect((await mandate(["rotate-key"])).code).toBe(0);
    const keys = await mandate(["journal", "key", "--out", file("both.pub.pem")]);
    expect(keys.out).toMatch(/^2 keys written to /);
    expect((await mandate(["journal", "verify", file("j1.json"), "--key", file("both.pub.pem")], false)).code).toBe(0);
    // The new key alone did not sign this run's anchors.
    writeFileSync(file("new.pub.pem"), (await mandate(["journal", "key"])).out.split("-----END PUBLIC KEY-----\n")[0] + "-----END PUBLIC KEY-----\n");
    const unknown = await mandate(["journal", "verify", file("j1.json"), "--key", file("new.pub.pem")], false);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain("anchor_unknown_key at seq 1");
    // Keys given one file each count the same.
    expect((await mandate(["journal", "verify", file("j1.json"), "--key", file("new.pub.pem"), "--key", file("cp.pub.pem")], false)).code).toBe(0);
  });

  it("refuses to verify without a key, or with a file that holds none", async () => {
    expect((await mandate(["journal", "verify", file("j1.json")], false)).code).toBe(2);
    expect((await mandate(["journal", "verify", file("missing.json"), "--key", file("cp.pub.pem")], false)).code).toBe(2);
    writeFileSync(file("not-a-key.pem"), "hello\n");
    const bad = await mandate(["journal", "verify", file("j1.json"), "--key", file("not-a-key.pem")], false);
    expect([bad.code, bad.err]).toEqual([1, expect.stringContaining("bad_journal_key")]);
    expect((await mandate(["journal", "frobnicate"])).code).toBe(2);
  });

  it("reports an export it cannot read as malformed, with what is wrong", async () => {
    writeFileSync(file("dup.json"), readFileSync(file("j1.json"), "utf8").replace('"tenant": "default"', '"tenant": "default", "tenant": "x"'));
    const r = await mandate(["journal", "verify", file("dup.json"), "--key", file("cp.pub.pem")], false);
    expect(r.code).toBe(1);
    expect(r.out).toContain('malformed_export: the export is not a journal export (a duplicate member "tenant"');
  });
});
