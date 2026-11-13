// `mandate show <run> --role R | --audit` (spec/boundary.md "Views by role and the audit view"): a role's view and the
// audit view from a terminal, in each format; the two together, and a role the program does not name, are refused.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-show-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, "ask.mdt"),
  `mandate @ 0.3

module cli.show @ 0.1

use std.{fs, human}

capability Note = fs.read("/tmp/notes")

workflow Ask() -> Untrusted<Text>
  caps   Note
  budget { spend: 1 USD }
{
  human.ask("Ship it?", role: "operator")
}
`,
);
writeFileSync(join(dir, "mandate.runtime.json"), JSON.stringify({ database: "pglite:db", decisions: { mode: "unsigned" } }));

async function mandate(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    const code = await main([...args, "--config", join(dir, "mandate.runtime.json")], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

describe("mandate show --role and --audit", () => {
  it("prints a role's view and the audit view in each format, and refuses both together and a role the program does not name", async () => {
    expect((await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "s1"])).out).toContain("waiting");

    const role = await mandate(["show", "s1", "--role", "operator"]);
    expect(role.code, role.err).toBe(0);
    expect(role.out).toMatch(/^# Run s1: Ask, as operator sees it\n/);
    // Before 0.4 a question names no role in its wait: it is asked of nobody this view can name.
    expect(role.out).toContain("It waits for nothing asked of operator.");
    expect(role.out).toContain("## Exceptions");
    expect(role.out).not.toContain("## Events");
    const json = JSON.parse((await mandate(["show", "s1", "--role", "operator", "--format", "json"])).out) as { kind: string; role: string };
    expect([json.kind, json.role]).toEqual(["run_role", "operator"]);
    expect((await mandate(["show", "s1", "--role", "operator", "--format", "html"])).out).toContain("Content-Security-Policy");

    const audit = await mandate(["show", "s1", "--audit"]);
    expect(audit.code, audit.err).toBe(0);
    expect(audit.out).toMatch(/^# Run s1: Ask, audit\n/);
    expect(audit.out).toContain("verified: the chain holds and every state change is anchored.");
    for (const heading of ["## Journal", "## Steps", "## Trace", "## Events", "## Halts"]) expect(audit.out).toContain(heading);
    const report = JSON.parse((await mandate(["show", "s1", "--audit", "--format", "json"])).out) as { kind: string; chain: { status: string } };
    expect([report.kind, report.chain.status]).toEqual(["run_audit", "verified"]);

    const both = await mandate(["show", "s1", "--role", "operator", "--audit"]);
    expect(both.code).toBe(2);
    expect(both.err).toContain("mandate: show takes --role R or --audit, not both\n");
    const unknown = await mandate(["show", "s1", "--role", "owner"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toBe("mandate: unknown_role: Run s1's program names no role owner; it names operator.\n");
    expect((await mandate(["show", "s1", "--role"])).code).toBe(2);

    // Without either, the view is the run's view as before.
    const plain = await mandate(["show", "s1"]);
    expect(plain.out).toMatch(/^# Run s1: Ask\n/);
    expect(plain.out).not.toContain("## Exceptions");
  });
});
