// An agent's `run` tool runs a component's command in that component's root
// (K8; design doc 9 §2.2): an agent that reads several components and tests
// one runs the tests where they are, and one that tests two names which.

import { capsOf, check, linkedProgram, requirementFor, type CapVal } from "@mandate/bridge";
import { describe, expect, it } from "vitest";
import { commandFor, Denied, plainHttpHosts, toolsFor } from "../src/tools.js";
import { BEFORE_HTTP_SENTENCE } from "./tools-before-http-sentence.js";

const SYSTEM = `mandate @ 0.3
module acme.mini @ 0.1
interface Api {
  protocol openapi
  spec "docs/openapi.json"
}
component web {
  repo "acme/web"
  root "/work/web"
  lang ts
  owner role "web_owner"
  test exec("npm", ["test"])
  consumes Api
}
component api {
  repo "acme/api"
  root "/work/api"
  lang ts
  owner role "api_owner"
  test exec("npm", ["test"])
  provides Api
}
`;

/** The expanded capabilities, as the runtime grants them, of `capability` lines over the mini system. */
function grants(caps: string, names: string[]): CapVal[] {
  const modules = { "acme.mini": check(SYSTEM, "mdt").program! };
  const src = `mandate @ 0.3
module acme.t @ 0.1
use std.{component}
use acme.mini.{web, api}
${caps}
`;
  const r = check(src, "mdt", { modules });
  expect(r.program, JSON.stringify(r.diagnostics)).toBeTruthy();
  const defs = linkedProgram(r.program!, modules).defs as never;
  return names.flatMap((name) => capsOf(defs, { op: "var", name } as never));
}

describe("run's working directory", () => {
  it("is the component's root when the agent may test one component", () => {
    const tools = toolsFor(grants(`capability R = component.read(web, api)
capability T = component.exec(api, test)`, ["R", "T"]), { type: "string" });
    const r = commandFor(tools, "run", { command: "npm", args: ["test"] });
    expect(r).toMatchObject({ argv: ["npm", "test"], cwd: "/work/api" });
  });

  it("must be named when the agent may test two, and only as one of their roots", () => {
    const tools = toolsFor(grants(`capability R = component.read(web, api)
capability TW = component.exec(web, test)
capability TA = component.exec(api, test)`, ["R", "TW", "TA"]), { type: "string" });
    expect(commandFor(tools, "run", { command: "npm", args: ["test"] })).toBeInstanceOf(Denied);
    expect(commandFor(tools, "run", { command: "npm", args: ["test"], cwd: "/work/web" })).toMatchObject({ cwd: "/work/web" });
    expect(commandFor(tools, "run", { command: "npm", args: ["test"], cwd: "/work" })).toBeInstanceOf(Denied);
    expect(JSON.stringify(tools.specs.find((s) => s.name === "run"))).toContain("cwd");
  });
});

describe("grep", () => {
  it("takes extended regular expressions and skips dependencies and build output", () => {
    const tools = toolsFor(grants(`capability R = component.read(web, api)`, ["R"]), { type: "string" });
    const r = commandFor(tools, "grep", { pattern: "MCP_RESOURCE|MCP_AUDIENCE", path: "/work/api" });
    expect(r).toMatchObject({ argv: expect.arrayContaining(["grep", "-rnIE", "--exclude-dir=node_modules", "--exclude-dir=.git", "--", "MCP_RESOURCE|MCP_AUDIENCE", "/work/api"]) });
  });
});

describe("a refusal's kind (spec/boundary.md \"Violations and halt\")", () => {
  const grant = [
    { ctor: "fs.read", scope: ["/work/repo"] },
    { ctor: "fs.write", scope: ["/work/repo/src"] },
    { ctor: "exec", scope: ["mvn"], argsPrefix: [["-q", "test"]] },
  ] as unknown as CapVal[];
  const tools = toolsFor(grant, { type: "string" });
  const kind = (name: string, input: Record<string, unknown>): string => {
    const r = commandFor(tools, name, input);
    return r instanceof Denied ? r.kind : "runs";
  };

  it("is authority when the call asks for what the grant does not give", () => {
    expect(kind("read_file", { path: "/etc/passwd" })).toBe("authority");
    expect(kind("list_dir", { path: "/work" })).toBe("authority");
    expect(kind("grep", { pattern: "x", path: "/" })).toBe("authority");
    expect(kind("write_file", { path: "/work/repo/README.md", content: "x" })).toBe("authority");
    expect(kind("run", { command: "rm", args: ["-rf", "/"] })).toBe("authority");
    expect(kind("run", { command: "mvn", args: ["deploy"] })).toBe("authority");
    expect(kind("run", { command: "mvn", args: ["-q", "test"], cwd: "/tmp" })).toBe("authority");
    // Outside the grant is checked first: a call out of scope and malformed besides asks for what it may not have.
    expect(kind("write_file", { path: "/etc/x" })).toBe("authority");
  });

  it("is malformed when the input is not one the tool takes", () => {
    expect(kind("read_file", {})).toBe("malformed");
    expect(kind("read_file", { path: "" })).toBe("malformed");
    expect(kind("grep", { path: "/work/repo" })).toBe("malformed");
    expect(kind("write_file", { path: "src/a.ts" })).toBe("malformed");
    expect(kind("run", { command: "mvn" })).toBe("malformed");
    expect(kind("run", { command: 1, args: [] })).toBe("malformed");
    expect(kind("teleport", {})).toBe("malformed");
  });

  it("leaves a call the grant gives to run", () => {
    expect(kind("read_file", { path: "src/a.ts" })).toBe("runs");
    expect(kind("run", { command: "mvn", args: ["-q", "test", "-o"] })).toBe("runs");
  });

  it("is malformed when a command allowed in several working copies names none, and authority when it names another", () => {
    const two = toolsFor(grants(`capability R = component.read(web, api)
capability TW = component.exec(web, test)
capability TA = component.exec(api, test)`, ["R", "TW", "TA"]), { type: "string" });
    expect(commandFor(two, "run", { command: "npm", args: ["test"] })).toMatchObject({ kind: "malformed" });
    expect(commandFor(two, "run", { command: "npm", args: ["test"], cwd: "/work" })).toMatchObject({ kind: "authority" });
  });
});

// ── What the model is told about http:// (spec/boundary.md "Sandbox egress") ──

const GRANTED = [
  { ctor: "fs.read", effect: "Fs", write: false, scope: ["/work/repo"] },
  { ctor: "fs.write", effect: "Fs", write: true, scope: ["/work/repo/src"] },
  { ctor: "exec", effect: "Exec", write: false, scope: ["fetch"] },
  { ctor: "exec", effect: "Exec", write: false, scope: ["mvn"], argsPrefix: [["-q", "test"]] },
] as unknown as CapVal[];
const net = (hosts: string[], methods?: string[]): CapVal => ({ ctor: "net.https", effect: "Net", write: false, scope: hosts, ...(methods ? { methods } : {}) });
/** The 0.5 requirement of an agent granted GRANTED and `caps`, the lock binding the hosts of `bound` to their credentials. */
function requirement(caps: CapVal[], bound: Record<string, string> = {}, language: "mandate/0.4" | "mandate/0.5" = "mandate/0.5") {
  const lock = Object.keys(bound).length ? { modules: {}, egress: { Fetcher: bound } } : { modules: {} };
  return requirementFor({ agent: "Fetcher", def: "sha256:0" }, [...GRANTED, ...caps], null, { language, lock });
}
const specs = (caps: CapVal[], bound: Record<string, string> = {}, grants = GRANTED) => toolsFor(grants, { type: "string" }, requirement(caps, bound)).specs;
const runText = (s: Array<{ name: string; description: string }>): string => s.find((t) => t.name === "run")!.description;
const SENTENCE = (hosts: string): string => ` Reach ${hosts} with http:// URLs, not https://: the connection is made over TLS for you, and an https:// URL to such a host is refused and counted as a violation.`;
const RUN = "Run a command and get its exit code and output. Allowed: fetch …; mvn -q test (further arguments may follow).";

describe("the sentence about http:// in the description of run", () => {
  it("leaves the tools of an agent the rule does not apply to byte for byte what they were: with no network, and with plain hosts only", () => {
    expect(JSON.stringify(toolsFor(GRANTED, { type: "string" }).specs)).toBe(BEFORE_HTTP_SENTENCE);
    expect(JSON.stringify(specs([]))).toBe(BEFORE_HTTP_SENTENCE);
    expect(JSON.stringify(specs([net(["api.github.com", "docs.example"])]))).toBe(BEFORE_HTTP_SENTENCE);
    // A requirement of format 0.1 (a program before 0.5) has no methods and no credentials: no host to name.
    const old = requirementFor({ agent: "Fetcher", def: "sha256:0" }, [...GRANTED, net(["api.github.com"], ["GET"])], null, { language: "mandate/0.4" });
    expect(JSON.stringify(toolsFor(GRANTED, { type: "string" }, old).specs)).toBe(BEFORE_HTTP_SENTENCE);
  });

  it("names a host the lock binds a credential to, by its host name only", () => {
    const s = specs([net(["api.github.com", "docs.example"])], { "api.github.com": "github" });
    expect(runText(s)).toBe(RUN + SENTENCE("api.github.com"));
    expect(runText(s).replaceAll("api.github.com", "")).not.toContain("github");
    expect(JSON.stringify(s.filter((t) => t.name !== "run"))).toBe(JSON.stringify(JSON.parse(BEFORE_HTTP_SENTENCE).filter((t: { name: string }) => t.name !== "run")));
  });

  it("names a host whose methods are limited", () => {
    expect(runText(specs([net(["api.github.com"], ["GET"]), net(["docs.example"])]))).toBe(RUN + SENTENCE("api.github.com"));
  });

  it("names each host once, in the order of their names as code units, whatever the order the grants list them in", () => {
    const both = specs([net(["zeta.example", "api.github.com"], ["GET"]), net(["Upper.example", "api.github.com", "plain.example"]), net(["zeta.example"])], { "api.github.com": "github", "zeta.example": "other", "Upper.example": "third" });
    // "U" sorts before "a" in code units; a host with both a credential and a limit is named once; the plain host is not named.
    expect(runText(both)).toBe(RUN + SENTENCE("Upper.example, api.github.com, zeta.example"));
    expect(JSON.stringify(both)).not.toMatch(/other|third/);
    expect(plainHttpHosts(requirement([net(["b.example", "a.example"], ["GET"])]))).toEqual(["a.example", "b.example"]);
  });

  it("is in no tool but run, and not at all for an agent that has no run", () => {
    const s = specs([net(["api.github.com"], ["GET"])]);
    expect(s.filter((t) => t.description.includes("http://")).map((t) => t.name)).toEqual(["run"]);
    const noRun = specs([net(["api.github.com"], ["GET"])], {}, [GRANTED[0]!]);
    expect(noRun.map((t) => t.name)).toEqual(["read_file", "list_dir", "grep", "finish"]);
    expect(JSON.stringify(noRun)).not.toContain("http://");
  });
});
