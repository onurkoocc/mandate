// The recorded conversations of vectors/mcp/ (written by scripts/mcp-vectors.mjs from this server, and replayed by the
// native server's tests) are replayed here through the Node server itself, every answer byte for byte. Without this, only
// the native server is held to them: a change of the Node server that the recording does not follow (the modules a view
// is given, the lock a tool reads, the pin of std.patterns) would pass every test of the bridge.
//
//   - a file with `language: "mandate/0.7"` is replayed through the server of that language;
//   - a file without one (0.1 to 0.6) is replayed through the server with no language (the frozen list), and through the
//     server of `mandate/0.6`: the library API's default and the door's list for that language are the same bytes.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { kindOf, loadModules } from "../src/index.js";
import { serveStdio } from "../src/mcp.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const dir = `${root}vectors/mcp/`;

type Part = { line?: string; text?: string; hex?: string; repeat?: string; count?: number };
type Answer = string | { sha256: string; bytes: number };
interface Conversation {
  name: string;
  language?: string;
  args: string[];
  input: Part[];
  output: Answer[];
}

const conversations: Conversation[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(dir + f, "utf8")) as Conversation);

function bytesOf(parts: Part[]): Buffer {
  return Buffer.concat(
    parts.map((p) => {
      if (p.line !== undefined) return Buffer.from(`${p.line}\n`, "utf8");
      if (p.text !== undefined) return Buffer.from(p.text, "utf8");
      if (p.hex !== undefined) return Buffer.from(p.hex, "hex");
      return Buffer.from(p.repeat!.repeat(p.count!), "utf8");
    }),
  );
}

/** What the server writes for the conversation's input, started as `mandate mcp <args>` starts it, serving `language`. */
async function serve(c: Conversation, language: string | undefined): Promise<string[]> {
  const files: string[] = [];
  for (let i = 1; i < c.args.length; i += 2) if (c.args[i] === "--module") files.push(c.args[i + 1]!);
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: readFileSync(root + file, "utf8"), kind: kindOf(file) })));
  expect(problems, c.name).toEqual([]);
  const out: Buffer[] = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      out.push(Buffer.from(chunk as Buffer));
      done();
    },
  });
  await serveStdio(Readable.from([bytesOf(c.input)]), output, modules, language);
  const written = Buffer.concat(out).toString("utf8");
  if (written === "") return [];
  expect(written.endsWith("\n"), c.name).toBe(true);
  return written.slice(0, -1).split("\n");
}

/** One answer as the file holds it: the line, or the digest and the length of a long one. */
function matches(got: string, want: Answer): boolean {
  if (typeof want === "string") return got === want;
  return Buffer.byteLength(got, "utf8") === want.bytes && `sha256:${createHash("sha256").update(got, "utf8").digest("hex")}` === want.sha256;
}

async function replay(c: Conversation, language: string | undefined): Promise<{ answers: number; problems: string[] }> {
  const got = await serve(c, language);
  const problems: string[] = [];
  if (got.length !== c.output.length) problems.push(`${c.name}: ${got.length} answers, ${c.output.length} recorded`);
  c.output.forEach((want, i) => {
    if (got[i] !== undefined && !matches(got[i]!, want)) problems.push(`${c.name}: answer ${i} differs: ${got[i]!.slice(0, 200)}`);
  });
  return { answers: c.output.length, problems };
}

describe("the recorded conversations of vectors/mcp/ through the Node server", () => {
  const of07 = conversations.filter((c) => c.language === "mandate/0.7");
  const before07 = conversations.filter((c) => c.language === undefined);

  it("hold the nine conversations of 0.7, and the rest are of 0.1 to 0.6", () => {
    expect(of07.map((c) => c.name)).toContain("authoring-0.7");
    expect(of07.length).toBeGreaterThanOrEqual(9);
    expect(before07.length).toBeGreaterThanOrEqual(15);
    for (const c of conversations) expect(c.language === undefined || c.language === "mandate/0.7", c.name).toBe(true);
  });

  it("answer the conversations of 0.7 byte for byte, served as mandate/0.7", async () => {
    const problems: string[] = [];
    let answers = 0;
    for (const c of of07) {
      const r = await replay(c, "mandate/0.7");
      answers += r.answers;
      problems.push(...r.problems);
    }
    expect(problems).toEqual([]);
    expect(answers).toBeGreaterThanOrEqual(70);
  }, 60_000);

  it("answer the conversations of 0.1 to 0.6 byte for byte, with no language and as mandate/0.6", async () => {
    const problems: string[] = [];
    let answers = 0;
    for (const c of before07) {
      for (const language of [undefined, "mandate/0.6"]) {
        const r = await replay(c, language);
        answers += r.answers;
        problems.push(...r.problems.map((p) => `${language ?? "no language"}: ${p}`));
      }
    }
    expect(problems).toEqual([]);
    expect(answers).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it("is a test that can fail: the server of 0.7 does not answer a conversation of 0.6 as the frozen one does", async () => {
    const c = before07.find((x) => x.name === "tools") ?? before07.find((x) => x.output.length > 0)!;
    const r = await replay(c, "mandate/0.7");
    const listed = c.input.some((p) => (p.line ?? "").includes("tools/list"));
    expect(r.problems.length > 0, c.name).toBe(listed);
  }, 60_000);
});
