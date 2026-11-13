// `mandate egress serve` from end to end (spec/egress.md "Running the
// proxy"): the proxy runs as a child process with a secret in its own
// environment; a client opens a session over the admin channel; a plain HTTP
// client sends requests through the session's port; the denials come back
// over the admin channel. Every request here is refused before the proxy
// would resolve a name or connect anywhere, so nothing reaches the network.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EgressClient } from "../src/egress/client.js";
import { adminPath, SECRET } from "./egress-world.js";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
let cli: string;
const dir = mkdtempSync(join(tmpdir(), "mdt-egcli-"));
const children: ChildProcessWithoutNullStreams[] = [];

beforeAll(async () => {
  const out = here("./.build");
  mkdirSync(out, { recursive: true });
  cli = join(out, `mandate-cli-${process.pid}.mjs`);
  await build({
    entryPoints: [here("./fixtures/mandate-cli.ts")],
    outfile: cli,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    alias: { "@mandate/compiler": here("../../compiler/src/index.ts") },
    external: ["pg", "@electric-sql/pglite", "@anthropic-ai/sdk", "@temporalio/*", "ajv", "ajv/*", "ajv-formats", "@microsoft/mxc-sdk", "@microsoft/mxc-sdk/*"],
    plugins: [
      {
        // The compiler reads its schemas from beside its own files, so each of its files keeps its own address.
        name: "own-address",
        setup(b) {
          b.onLoad({ filter: /[\\/]compiler[\\/]src[\\/].*\.ts$/ }, (a) => ({ contents: readFileSync(a.path, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(a.path).href)), loader: "ts" }));
        },
      },
    ],
    logLevel: "error",
  });
}, 60_000);

afterAll(() => {
  for (const c of children) c.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
  rmSync(cli, { force: true });
});

function configFile(admin: string): string {
  const file = join(dir, `mandate.egress.${children.length}.json`);
  writeFileSync(file, JSON.stringify({ admin, credentials: { github: { env: "MANDATE_EGRESS_GITHUB", hosts: ["api.github.com"], header: "authorization", template: "Bearer {secret}" } } }));
  return file;
}

/** `mandate egress serve` as a child, with `env` as its own environment; resolves with its first line on stdout. */
function serve(file: string, env: NodeJS.ProcessEnv): { child: ChildProcessWithoutNullStreams; out: () => string; err: () => string; ready: Promise<string>; exit: Promise<number | null> } {
  const child = spawn(process.execPath, [cli, "egress", "serve", "--config", file], { env });
  children.push(child);
  let out = "";
  let err = "";
  const ready = new Promise<string>((ok, fail) => {
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString();
      if (out.includes("\n")) ok(out);
    });
    child.once("exit", () => fail(new Error(`exited before it was ready: ${err}`)));
  });
  child.stderr.on("data", (c: Buffer) => (err += c.toString()));
  const exit = new Promise<number | null>((ok) => child.once("exit", (code) => ok(code)));
  ready.catch(() => {});
  return { child, out: () => out, err: () => err, ready, exit };
}

/** A plain HTTP client's request through a forward proxy at `port`. */
function viaProxy(port: number, method: string, url: string): Promise<{ status: number; why: string | undefined }> {
  return new Promise((ok, fail) => {
    const req = request({ host: "127.0.0.1", port, method, path: url, headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      res.on("end", () => ok({ status: res.statusCode!, why: res.headers["x-mandate-egress-denied"] as string | undefined }));
    });
    req.on("error", fail);
    req.end();
  });
}

describe("mandate egress serve", () => {
  it("serves sessions to a client, denies what a session does not allow, and lists the denials", async () => {
    const where = adminPath();
    const env = { ...process.env, MANDATE_EGRESS_GITHUB: SECRET };
    const p = serve(configFile(where.path), env);
    expect(await p.ready).toMatch(/^mandate egress: ready, mandate\/egress\/0\.1 on .+, sessions on 127\.0\.0\.1, credentials github\n$/);
    const client = await EgressClient.connect(where.path);
    try {
      expect(await client.hello()).toEqual({ format: "mandate/egress/0.1", credentials: ["github"] });
      const s = await client.openSession({
        session: "cli-1",
        tenant: "acme",
        run: "r1",
        command: "c1",
        kind: "forward",
        destinations: [
          { host: "api.github.com", methods: ["GET"], credential: "github" },
          { host: "127.0.0.1", methods: null, credential: null },
        ],
        ttl_ms: 60_000,
      });
      const port = Number(new URL(s.proxy_url).port);
      expect(await viaProxy(port, "GET", "http://evil.example/collect")).toEqual({ status: 403, why: "host_not_allowed" });
      expect(await viaProxy(port, "DELETE", "http://api.github.com/repos/acme/app")).toEqual({ status: 403, why: "method_not_allowed" });
      expect(await viaProxy(port, "GET", "http://127.0.0.1/admin")).toEqual({ status: 403, why: "resolved_private" });
      const { denials } = await client.denials("cli-1");
      expect(denials.map((d) => [d.host, d.method, d.why])).toEqual([
        ["evil.example", "GET", "host_not_allowed"],
        ["api.github.com", "DELETE", "method_not_allowed"],
        ["127.0.0.1", "GET", "resolved_private"],
      ]);
    } finally {
      client.close();
    }
    p.child.kill("SIGTERM");
    const code = await p.exit;
    expect(p.out() + p.err()).not.toContain(SECRET);
    // On POSIX the signal lets it close its sessions and remove its socket; Windows has no SIGTERM to catch.
    if (process.platform !== "win32") {
      expect(code).toBe(0);
      expect(existsSync(where.path)).toBe(false);
    }
    where.cleanup();
  });

  it("does not start when a secret's variable is missing, and says which", async () => {
    const where = adminPath();
    const env = { ...process.env };
    delete env["MANDATE_EGRESS_GITHUB"];
    const p = serve(configFile(where.path), env);
    expect(await p.exit).toBe(1);
    expect(p.out()).toBe("");
    expect(p.err()).toContain("egress_secret_missing: credential github: the environment variable MANDATE_EGRESS_GITHUB is not set");
    if (process.platform !== "win32") expect(existsSync(where.path)).toBe(false);
    where.cleanup();
  });
});
