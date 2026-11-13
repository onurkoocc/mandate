// `mandate halt` (spec/boundary.md "Violations and halt"): the operator halts a tenant from a terminal, sees the
// runs it ended, lists the halts, and lifts one with who lifted it.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "mandate-halt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

writeFileSync(
  join(dir, "ask.mdt"),
  `mandate @ 0.2

module cli.halt @ 0.1

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

async function mandate(args: string[]): Promise<{ code: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => ((err += s), true)) as typeof process.stderr.write;
  try {
    // No secret in the environment: an operator's halt needs none.
    const code = await main([...args, "--config", join(dir, "mandate.runtime.json")], (s) => (out += s), {});
    return { code, out, err };
  } finally {
    process.stderr.write = write;
  }
}

describe("mandate halt", () => {
  it("halts a tenant, ends its runs, refuses a start, lists the halt, and lifts it with --by", async () => {
    expect((await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "h1"])).out).toContain("waiting");

    const halted = await mandate(["halt", "--tenant", "default", "--reason", "drill", "--by", "ops"]);
    expect(halted.code, halted.err).toBe(0);
    const id = halted.out.match(/^halted tenant default: (halt-[0-9a-f-]+) \(drill\)\n/)?.[1];
    expect(id).toBeDefined();
    expect(halted.out).toContain("1 run ended\n  h1  default  cancelled\n");
    expect(halted.out).toContain("starts and resumes in tenant default are refused until mandate halt --lift --tenant default --by <you>\n");
    expect(halted.out).toContain("revoke: nothing configured holds sessions to revoke\n");
    expect((await mandate(["status", "h1"])).out).toContain("cancelled");

    const refused = await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "h2"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`halted: Run h2 does not start: tenant default is halted (${id}: drill)`);

    const listed = await mandate(["halt", "--list"]);
    expect(listed.out).toMatch(new RegExp(`^${id}  tenant default  in force; halted by ops at \\S+: drill\\n$`));
    expect(JSON.parse((await mandate(["halt", "--list", "--json"])).out)).toMatchObject([{ halt_id: id, tenant: "default", reason: "drill", halted_by: "ops", lifted_at: null }]);

    const lifted = await mandate(["halt", "--lift", "--tenant", "default", "--by", "erin"]);
    expect(lifted.code, lifted.err).toBe(0);
    expect(lifted.out).toBe(`lifted ${id} (tenant default), by erin\nno run comes back: what the halt ended stays ended\n`);
    expect((await mandate(["halt", "--list"])).out).toMatch(/lifted by erin at /);
    expect((await mandate(["status", "h1"])).out).toContain("cancelled");
    expect((await mandate(["run", join(dir, "ask.mdt"), "--workflow", "Ask", "--input", "{}", "--run-id", "h3"])).out).toContain("waiting");
  });

  it("says when a tenant stays halted by a halt of every tenant, and refuses a lift where none is in force", async () => {
    expect((await mandate(["halt", "--all"])).out).toMatch(/^halted every tenant: halt-\S+\n1 run ended\n  h3  default  cancelled\n/);
    expect((await mandate(["halt", "--tenant", "default"])).out).toContain("0 runs ended");
    const lifted = await mandate(["halt", "--lift", "--tenant", "default", "--by", "erin"]);
    expect(lifted.out).toMatch(/tenant default is still halted by halt-\S+ \(every tenant\)\n/);
    const none = await mandate(["halt", "--lift", "--tenant", "default", "--by", "erin"]);
    expect(none.code).toBe(1);
    expect(none.err).toContain("not_halted: No halt of tenant default is in force.");
    expect((await mandate(["halt", "--lift", "--all", "--by", "erin"])).code).toBe(0);
  });

  it("takes one scope, and a lift takes --by", async () => {
    for (const args of [["halt"], ["halt", "--all", "--tenant", "x"], ["halt", "--lift", "--all"], ["halt", "--lift", "--all", "--by", "erin", "--reason", "x"], ["halt", "--list", "--all"], ["halt", "r1", "--all"]]) {
      expect((await mandate(args)).code, args.join(" ")).toBe(2);
    }
  });
});
