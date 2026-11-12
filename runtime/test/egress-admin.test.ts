// The egress proxy's configuration and admin channel (spec/egress.md
// "Configuration", "Admin channel"): a strict configuration whose secrets are
// read from the proxy's own environment; `hello`, `open_session`,
// `close_session`, `revoke` and `denials` over a socket or named pipe, one
// JSON object per line; sessions that expire, are revoked and are closed.

import { spawn } from "node:child_process";
import { lstatSync, mkdtempSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { serveAdmin } from "../src/egress/admin.js";
import { EgressClient } from "../src/egress/client.js";
import { egressConfig, readEgressConfig, readSecrets } from "../src/egress/config.js";
import { EgressProxy, type Destination } from "../src/egress/proxy.js";
import { adminPath, CONFIG, http, portOf, SECRET, send, sid, world, type World } from "./egress-world.js";

const OPEN: Destination = { host: "registry.npmjs.org", methods: null, credential: null };
const GITHUB: Destination = { host: "api.github.com", methods: null, credential: "github" };
const get = (host: string): string => http([`GET http://${host}/x HTTP/1.1`, `host: ${host}`]);

let w: World;
beforeAll(async () => {
  w = await world({ lingerMs: 300 });
});
afterAll(async () => {
  await w.close();
});

const open = (o: { tenant?: string; run?: string; ttl_ms?: number; destinations?: Destination[] } = {}) => {
  const id = sid();
  return w.client.openSession({ session: id, tenant: o.tenant ?? "acme", run: o.run ?? "r1", command: "c1", kind: "forward", destinations: o.destinations ?? [OPEN, GITHUB], ttl_ms: o.ttl_ms ?? 60_000 }).then((s) => ({ id, port: portOf(s.proxy_url), ph: s.placeholders }));
};

/** One raw line on the admin channel, and the one line that answers it. */
function line(text: string): Promise<Record<string, unknown>> {
  return new Promise((ok, fail) => {
    const s = connect({ path: w.admin.path });
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c: string) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        s.destroy();
        ok(JSON.parse(buf.slice(0, nl)) as Record<string, unknown>);
      }
    });
    s.on("error", fail);
    s.write(text + "\n");
  });
}

describe("the configuration", () => {
  const base = { admin: "egress.sock", ...CONFIG };
  const bad = (c: unknown) => () => egressConfig(c, "mandate.egress.json", tmpdir());

  it("is strict: an unknown field, at the top or in a credential, is an error", () => {
    expect(bad({ ...base, proxy: 1 })).toThrow(/bad_egress_config: mandate.egress.json: unknown field proxy/);
    expect(bad({ ...base, credentials: { github: { ...CONFIG.credentials.github, scope: "repo" } } })).toThrow(/unknown field credentials.github.scope/);
  });

  it("takes a loopback address to listen on, and nothing else", () => {
    expect(egressConfig(base, "f", tmpdir()).listen).toBe("127.0.0.1");
    expect(egressConfig({ ...base, listen: "::1" }, "f", tmpdir()).listen).toBe("::1");
    for (const listen of ["0.0.0.0", "10.0.0.1", "localhost", "::"]) expect(bad({ ...base, listen }), listen).toThrow(/loopback/);
  });

  it("refuses a credential whose template lacks {secret}, whose header the proxy sets itself, or whose hosts are not host names", () => {
    expect(bad({ ...base, credentials: { github: { ...CONFIG.credentials.github, template: "Bearer" } } })).toThrow(/\{secret\} exactly once/);
    expect(bad({ ...base, credentials: { github: { ...CONFIG.credentials.github, header: "host" } } })).toThrow(/sets or removes that header/);
    expect(bad({ ...base, credentials: { github: { ...CONFIG.credentials.github, hosts: ["api.github.com:443"] } } })).toThrow(/without a port/);
    expect(bad({ ...base, credentials: { github: { ...CONFIG.credentials.github, hosts: [] } } })).toThrow(/non-empty list/);
  });

  it("reads a file, with paths relative to it", () => {
    const dir = mkdtempSync(join(tmpdir(), "mdt-egcfg-"));
    writeFileSync(join(dir, "mandate.egress.json"), JSON.stringify({ ...base, ca: "roots.pem" }));
    const c = readEgressConfig(join(dir, "mandate.egress.json"));
    expect([c.admin, c.ca]).toEqual([join(dir, "egress.sock"), join(dir, "roots.pem")]);
    writeFileSync(join(dir, "dup.json"), '{"admin":"a","admin":"b"}');
    expect(() => readEgressConfig(join(dir, "dup.json"))).toThrow(/bad_egress_config/);
  });

  it("reads each secret from the variable it names, and stops on one that is missing, naming the variable and nothing else", () => {
    const c = egressConfig(base, "f", tmpdir());
    expect(() => readSecrets(c, { MANDATE_EGRESS_GITHUB: SECRET })).toThrow(/egress_secret_missing: credential model: the environment variable MANDATE_EGRESS_MODEL is not set/);
    expect(() => readSecrets(c, { MANDATE_EGRESS_GITHUB: SECRET, MANDATE_EGRESS_MODEL: "" })).toThrow(/egress_secret_missing/);
    expect(() => readSecrets(c, { MANDATE_EGRESS_GITHUB: SECRET, MANDATE_EGRESS_MODEL: "short" })).toThrow(/egress_secret_invalid/);
    try {
      readSecrets(c, { MANDATE_EGRESS_GITHUB: "with a\r\nnewline", MANDATE_EGRESS_MODEL: SECRET });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toMatch(/egress_secret_invalid/);
      expect((e as Error).message).not.toContain("newline");
    }
    expect(readSecrets(c, { MANDATE_EGRESS_GITHUB: SECRET, MANDATE_EGRESS_MODEL: SECRET }).get("github")?.toString()).toBe(SECRET);
  });
});

describe("hello", () => {
  it("answers with the protocol's version and the credentials' names, never a secret", async () => {
    const h = await w.client.hello();
    expect(h).toEqual({ format: "mandate/egress/0.1", credentials: ["github", "model"] });
    expect(JSON.stringify(await line('{"id":1,"op":"hello"}'))).not.toContain(SECRET);
  });
});

describe("open_session", () => {
  it("refuses to bind a credential to a host the proxy's configuration does not list for it", async () => {
    await expect(open({ destinations: [{ host: "evil.example", methods: null, credential: "github" }] })).rejects.toMatchObject({ code: "credential_not_allowed" });
    await expect(open({ destinations: [{ host: "api.github.com", methods: null, credential: "model" }] })).rejects.toMatchObject({ code: "credential_not_allowed" });
    await expect(open({ destinations: [{ host: "api.github.com", methods: null, credential: "gitlab" }] })).rejects.toMatchObject({ code: "unknown_credential" });
  });

  it("refuses a session id already open, and a malformed destination", async () => {
    const s = await open();
    await expect(w.client.openSession({ session: s.id, tenant: "acme", run: "r1", command: "c1", kind: "forward", destinations: [OPEN], ttl_ms: 1000 })).rejects.toMatchObject({ code: "session_exists" });
    await expect(open({ destinations: [{ host: "API.github.com", methods: null, credential: null }] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(open({ destinations: [OPEN, OPEN] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(open({ destinations: [{ host: "x.example", methods: [], credential: null }] })).rejects.toMatchObject({ code: "bad_request" });
    await expect(open({ destinations: [] })).rejects.toMatchObject({ code: "bad_request" });
  });

  it("listens on its own ephemeral loopback port", async () => {
    const a = await open();
    const b = await open();
    expect(a.port).toBeGreaterThan(0);
    expect(a.port).not.toBe(b.port);
  });
});

describe("the lines of the admin channel", () => {
  it("answers a line that is not a JSON object, an unknown operation and an unknown field with a code", async () => {
    expect(await line("not json")).toMatchObject({ id: null, ok: false, error: { code: "bad_request" } });
    expect(await line('{"id":"a","op":"shutdown"}')).toMatchObject({ id: "a", ok: false, error: { code: "unknown_op" } });
    expect(await line('{"id":2,"op":"hello","extra":1}')).toMatchObject({ id: 2, ok: false, error: { code: "bad_request" } });
    expect(await line('{"op":"hello"}')).toMatchObject({ id: null, ok: false, error: { code: "bad_request" } });
    expect(await line('{"id":3,"op":"revoke","run":"r1","tenant":"acme"}')).toMatchObject({ id: 3, ok: false, error: { code: "bad_request" } });
    expect(await line('{"id":4,"op":"denials","session":"nope"}')).toMatchObject({ id: 4, ok: false, error: { code: "unknown_session" } });
  });

  it("closes a connection whose line is longer than 1 MiB", async () => {
    const answer = await new Promise<string>((ok) => {
      const s = connect({ path: w.admin.path });
      let buf = "";
      s.setEncoding("utf8");
      s.on("data", (c: string) => (buf += c));
      s.on("close", () => ok(buf));
      s.on("error", () => {});
      s.write("x".repeat(1024 * 1024 + 10));
    });
    expect(answer).toContain("line_too_long");
  });
});

describe("revocation, expiry and closing", () => {
  it("revokes by run, by tenant and all", async () => {
    const r1 = await open({ tenant: "t1", run: "run-a" });
    const r2 = await open({ tenant: "t1", run: "run-b" });
    const r3 = await open({ tenant: "t2", run: "run-c" });
    expect(await w.client.revoke({ run: "run-a" })).toEqual([r1.id]);
    expect(await w.client.revoke({ tenant: "t1" })).toEqual([r1.id, r2.id].sort());
    const all = await w.client.revoke({ all: true });
    expect(all).toContain(r3.id);
  });

  it("closes a revoked or expired session once it has lingered: its port stops listening and its denials are gone", async () => {
    const s = await open({ ttl_ms: 20 });
    await new Promise((ok) => setTimeout(ok, 600));
    await expect(w.client.denials(s.id)).rejects.toMatchObject({ code: "unknown_session" });
    await expect(send(s.port, get("registry.npmjs.org"))).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("closes a session on close_session", async () => {
    const s = await open();
    await w.client.closeSession(s.id);
    await expect(send(s.port, get("registry.npmjs.org"))).rejects.toMatchObject({ code: "ECONNREFUSED" });
    await expect(w.client.closeSession(s.id)).rejects.toMatchObject({ code: "unknown_session" });
  });
});

describe("the admin socket", () => {
  it.skipIf(process.platform === "win32")("is created owner-only on POSIX", () => {
    expect(lstatSync(w.admin.path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === "win32")("replaces a socket file nobody listens on, and refuses one somebody does", async () => {
    const where = adminPath();
    // A stale socket: a process that listened on it and was killed, so nothing removed its file.
    const child = spawn(process.execPath, ["-e", `require("node:net").createServer().listen(${JSON.stringify(where.path)}, () => console.log("up"))`], { stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((ok) => child.stdout.once("data", () => ok()));
    child.kill("SIGKILL");
    await new Promise<void>((ok) => child.once("exit", () => ok()));
    expect(lstatSync(where.path).isSocket()).toBe(true);
    const proxy = new EgressProxy({ config: w.config, secrets: new Map([["github", Buffer.from(SECRET)], ["model", Buffer.from(SECRET)]]) });
    const admin = await serveAdmin(proxy, where.path);
    const c = await EgressClient.connect(where.path);
    expect((await c.hello()).format).toBe("mandate/egress/0.1");
    await expect(serveAdmin(proxy, where.path)).rejects.toThrow(/another process listens/);
    c.close();
    await admin.close();
    expect(() => lstatSync(where.path)).toThrow();
    where.cleanup();
  });
});
