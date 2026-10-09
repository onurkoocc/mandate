// Boundary evidence against the real Kervan (design doc 9 §12, B5; examples/
// kervan/kervan-system/tasks/KD-03). With MANDATE_KERVAN=1 and Docker: the
// seven repositories are copied into a workspace of their own, kervan-mcp
// gets the faulty audience change of task KD-03, and Mandate's boundary
// verifier checks it. kervan-mcp's own 43 tests pass in a container sandbox
// with no network, every interface spec is unchanged, and only the end-to-end
// check on the real system, on an internal network, fails. Restored, the end-
// to-end check passes. Takes a few minutes the first time (image builds).

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SystemFacts, VerifyRequest } from "../src/adapters.js";
import { BoundaryVerifier } from "../src/boundary.js";
import { ContainerHost } from "../src/container.js";
import { MxcAdapter } from "../src/sandbox.js";

const LIVE = process.env["MANDATE_KERVAN"] === "1";
const KERVAN = new URL("../../examples/kervan/", import.meta.url);
const COMPONENTS = ["auth", "mcp", "core", "search", "voice", "voice-evals"];
const git = (cwd: string, ...a: string[]): string => execFileSync("git", ["-c", "user.email=b5@mandate", "-c", "user.name=b5", "-c", "core.autocrlf=false", ...a], { cwd, encoding: "utf8" });

describe.runIf(LIVE)("KD-03 on the real Kervan: caught only at the boundary (B5)", () => {
  let src: string;
  let sys: SystemFacts;
  let verifier: BoundaryVerifier;
  const edit = (file: string, from: string, to: string): void => {
    const p = join(src, "kervan-mcp", file);
    const text = readFileSync(p, "utf8");
    if (!text.includes(from)) throw new Error(`${file} no longer has ${from}`);
    writeFileSync(p, text.replace(from, to));
  };

  beforeAll(() => {
    src = mkdtempSync(join(tmpdir(), "mandate-kervan-"));
    for (const c of [...COMPONENTS, "system"]) {
      const from = fileURLToPath(new URL(`kervan-${c}`, KERVAN));
      const to = join(src, `kervan-${c}`);
      // What the repository holds: its files, without what it ignores (dependencies, builds, generated data).
      for (const f of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: from, encoding: "utf8" }).split("\n").filter(Boolean)) {
        mkdirSync(dirname(join(to, f)), { recursive: true });
        copyFileSync(join(from, f), join(to, f));
      }
      git(to, "init", "-q", "-b", "main");
      git(to, "add", "-A");
      git(to, "commit", "-q", "-m", "seed");
    }
    // mcp's dependencies, from its lock file and without scripts, for the platform its tests run on (a Linux container):
    // the harness's step, before any candidate exists.
    execFileSync("docker", ["run", "--rm", "--mount", `type=bind,source=${join(src, "kervan-mcp").replace(/\\/g, "/")},target=/src`, "-w", "/src", "node:22-slim", "npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { stdio: "ignore" });
    const comp = (name: string, lang: string, provides: string[], consumes: string[], test: Array<{ command: string; args: string[] }>) => {
      const root = join(src, `kervan-${name === "evals" ? "voice-evals" : name}`).replace(/\\/g, "/");
      return { repo: `onurkoocc/kervan-${name}`, root, base: git(root, "rev-parse", "HEAD").trim(), lang, build: [], test, provides, consumes };
    };
    sys = {
      components: {
        auth: comp("auth", "ts", ["TokenIssuance"], [], []),
        mcp: comp("mcp", "ts", ["CustomerTools"], ["CoreApi", "SearchApi", "TokenIssuance"], [{ command: "npm", args: ["test"] }]),
        core: comp("core", "java", ["CoreApi", "CoreSchema"], [], []),
        search: comp("search", "py", ["SearchApi"], [], []),
        voice: comp("voice", "ts", ["AgentApi"], ["CustomerTools", "TokenIssuance"], []),
      },
      interfaces: {
        TokenIssuance: { protocol: "oauth", spec: "docs/oauth-metadata.json", provider: "auth" },
        CustomerTools: { protocol: "mcp_tools", spec: "docs/mcp-tools.json", provider: "mcp" },
        CoreApi: { protocol: "openapi", spec: "docs/openapi.json", provider: "core" },
        CoreSchema: { protocol: "db_schema", spec: "src/main/resources/db/migration", provider: "core" },
        SearchApi: { protocol: "openapi", spec: "docs/openapi.json", provider: "search" },
        AgentApi: { protocol: "openapi", spec: "docs/openapi.json", provider: "voice" },
      },
    };
    const host = new ContainerHost({ images: { npm: "node:22-slim" } });
    const sandbox = new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true, isolation: "container" });
    verifier = new BoundaryVerifier(
      {
        integration: { dir: join(src, "kervan-system", "compose"), files: ["base.yml", "staging.yml", "integration.yml"], service: "e2e", env: { KERVAN_SRC: src.replace(/\\/g, "/"), KERVAN_TAG: "b5" }, timeoutMs: 1_800_000 },
      },
      sandbox,
    );
  }, 600_000);

  afterAll(() => {
    if (src) rmSync(src, { recursive: true, force: true });
  });

  const req = (method: string, args: VerifyRequest["args"], named: VerifyRequest["named"] = {}): VerifyRequest => ({ method, args, named, contract: "BoundaryAccepted", criterion: method, system: sys });

  it("the faulty candidate passes mcp's own tests and every contract diff, and fails end to end", async () => {
    // KD-03: mcp's expected audience becomes its own setting, defaulting to its origin; its tests follow it.
    edit("src/config.ts", "  resource: string;\n", "  resource: string;\n  /** Expected token `aud`: the server rather than one endpoint. */\n  audience: string;\n");
    edit("src/config.ts", '    resource: value("MCP_RESOURCE", "http://mcp:3001/mcp"),\n', '    resource: value("MCP_RESOURCE", "http://mcp:3001/mcp"),\n    audience: value("MCP_AUDIENCE", new URL(value("MCP_RESOURCE", "http://mcp:3001/mcp")).origin),\n');
    edit("src/auth.ts", "payload.aud !== config.resource", "payload.aud !== config.audience");
    edit("test/helpers.ts", 'export const RESOURCE = "http://mcp:3001/mcp";', 'export const RESOURCE = "http://mcp:3001/mcp";\nexport const AUDIENCE = "http://mcp:3001";');
    edit("test/helpers.ts", ".setAudience(o.aud ?? RESOURCE)", ".setAudience(o.aud ?? AUDIENCE)");

    const suites = await verifier.check(req("test.suite_each", [["mcp"]]));
    expect(suites.passed, JSON.stringify(suites.detail).slice(0, 3000)).toBe(true);
    // The change updated mcp's tests with its behavior; the evidence says which.
    expect(JSON.stringify(suites.detail)).toContain("test/helpers.ts");
    const contracts = await verifier.check(req("test.contract", [{}]));
    expect(contracts.passed, JSON.stringify(contracts.detail)).toBe(true);
    const integrated = await verifier.check(req("test.integration", [["mcp"]], { env: "staging" }));
    expect(integrated.passed, JSON.stringify(integrated.detail).slice(0, 3000)).toBe(false);
    expect(JSON.stringify(integrated.detail)).not.toContain("integration_isolation");
  }, 2_400_000);

  it("restored, the end-to-end check passes", async () => {
    git(join(src, "kervan-mcp"), "checkout", "--", ".");
    const integrated = await verifier.check(req("test.integration", [["mcp"]], { env: "staging" }));
    expect(integrated.passed, JSON.stringify(integrated.detail).slice(0, 3000)).toBe(true);
  }, 2_400_000);
});
