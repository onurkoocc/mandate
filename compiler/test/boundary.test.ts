// The compile-time surface of 0.5 (spec/boundary.md): `methods` of
// `net.https` is read from 0.5 and narrows like a scope; a program of 0.1 to
// 0.4 that writes it reads it as it always did, as nothing.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { capCovers, capFromCall, capsOf, readMethods, showCap, type CapVal } from "../src/check/caps.js";
import type { Expr, LanguageVersion, Program } from "../src/ir/types.js";
import type { Lock } from "../src/lock.js";
import { requirementFor, sandboxRequirements } from "../src/target/sandbox.js";
import { authority, semanticDiff } from "../src/views/views.js";
import { readRepo } from "./helpers.js";

const FETCH = readRepo("fixtures/boundary/fetch.mdt");
const CAPABILITIES = readRepo("compiler/test/fixtures/syntax/capabilities.mdt");

function program(src: string): Program {
  const r = check(src, "mdt");
  expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`)).toEqual([]);
  return r.program!;
}

/** `fetch.mdt` with one change, which must still be in the file. */
function fetch(from: string, to: string): string {
  expect(FETCH.includes(from), from).toBe(true);
  return FETCH.replace(from, to);
}

const https = (methods?: string[]): Expr => ({
  op: "call",
  callee: { op: "field", of: { op: "var", name: "net" }, name: "https" },
  args: [
    { name: "hosts", value: { op: "list", items: [{ op: "text", value: "api.github.com" }] } },
    ...(methods ? [{ name: "methods", value: { op: "list" as const, items: methods.map((name) => ({ op: "var" as const, name })) } }] : []),
  ],
});

const net = (methods?: string[]): CapVal => ({ ctor: "net.https", effect: "Net", write: false, scope: ["api.github.com"], ...(methods ? { methods } : {}) });

describe("methods of net.https", () => {
  it("are read from 0.5, sorted and without duplicates", () => {
    expect(capFromCall(https(["POST", "GET", "POST"]), { language: "mandate/0.5" })?.methods).toEqual(["GET", "POST"]);
  });

  it.each(["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4"] as LanguageVersion[])("are not read in %s, nor without a language", (language) => {
    expect(capFromCall(https(["GET"]), { language })).toEqual(capFromCall(https()));
    expect(capFromCall(https(["GET"]))).toEqual({ ctor: "net.https", effect: "Net", write: false, scope: ["api.github.com"] });
  });

  it("are not read in the 0.1 fixture that writes them, which checks and shows as it did", () => {
    const p = program(CAPABILITIES);
    expect(p.language).toBe("mandate/0.1");
    expect(capsOf(p.defs, { op: "var", name: "CIApi" }, { language: p.language })).toEqual([{ ctor: "net.https", effect: "Net", write: false, scope: ["ci.internal.example"], name: "CIApi" }]);
    // The same text in 0.5 allows GET and POST only.
    const later = program(CAPABILITIES.replace("module company.devflow", "mandate @ 0.5\n\nmodule company.devflow"));
    expect(capsOf(later.defs, { op: "var", name: "CIApi" }, { language: later.language })[0]?.methods).toEqual(["GET", "POST"]);
  });

  it("narrow like a scope: a capability with methods covers one only with the same methods or fewer", () => {
    expect(capCovers(net(["GET", "POST"]), net(["GET"]))).toBe(true);
    expect(capCovers(net(["GET"]), net(["GET"]))).toBe(true);
    expect(capCovers(net(["GET"]), net(["GET", "POST"]))).toBe(false);
    // Without methods, any method: it covers every method set, and is covered by none.
    expect(capCovers(net(), net(["DELETE"]))).toBe(true);
    expect(capCovers(net(), net())).toBe(true);
    expect(capCovers(net(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]), net())).toBe(false);
  });

  it("are shown with the capability, which is shown as before without them", () => {
    expect(showCap({ ...net(["GET"]), name: "R" })).toBe('R = net.https("api.github.com", methods: [GET])');
    expect(showCap({ ...net(), name: "R" })).toBe('R = net.https("api.github.com")');
    expect(showCap({ ctor: "net.https", effect: "Net", write: false, scope: [] })).toBe("net.https()");
  });

  it("are a non-empty list of bare names the language knows", () => {
    expect(readMethods({ op: "list", items: [{ op: "var", name: "GET" }, { op: "text", value: "POST" }, { op: "var", name: "get" }] })).toEqual({
      methods: ["GET"],
      problems: [
        { at: "/items/1", found: "POST", problem: "not_a_name" },
        { at: "/items/2", found: "get", problem: "unknown" },
      ],
    });
    expect(readMethods({ op: "list", items: [] }).problems).toEqual([{ at: "", found: null, problem: "empty" }]);
    expect(readMethods({ op: "var", name: "GET" }).problems).toEqual([{ at: "", found: null, problem: "not_a_list" }]);
  });

  it("are checked in 0.5 only (E1801)", () => {
    const bad = fetch("methods: [GET]", "methods: [GET, FETCH]");
    const r = check(bad, "mdt");
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.facts?.["found"]])).toEqual([["MDT-E1801", "/defs/GitHubRead/value/args/1/value/items/1", "FETCH"]]);
    expect(r.diagnostics[0]!.message).toBe("Unknown method FETCH; net.https allows GET, HEAD, POST, PUT, PATCH or DELETE.");
    expect(check(bad.replace("mandate @ 0.5", "mandate @ 0.4"), "mdt").ok).toBe(true);
  });

  it("bound what a delegation is handed: any method of a host that the workflow and the agent allow only GET of is neither available nor held (E0701)", () => {
    const r = check(fetch("  delegate Reader.summarize(issue)", "  delegate Reader.summarize(issue) with caps GitHubAny").replace("capability ModelStd", 'capability GitHubAny  = net.https(hosts: ["api.github.com"])\ncapability ModelStd'), "mdt");
    expect(r.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.at.path, d.message])).toEqual([
      ["MDT-E0701", "/defs/Summarize/body/0/value/caps/0", "GitHubAny = net.https(\"api.github.com\") is not available in Summarize, so it cannot be delegated (C2)."],
      ["MDT-E0701", "/defs/Summarize/body/0/value/caps/0", "Reader does not hold GitHubAny = net.https(\"api.github.com\"); 'with caps' can only narrow what the agent already holds (C2)."],
    ]);
  });
});

describe("views of methods", () => {
  it("show each host with the methods the capability allows", () => {
    const v = authority(program(FETCH));
    expect(v.rows.find((r) => r.who === "Reader")?.network).toEqual(["api.github.com (GET)"]);
  });

  it("call a widened method set, and a removed methods, a governance change, and fewer methods a narrowing", () => {
    const before = program(FETCH);
    const wider = semanticDiff(before, program(fetch("methods: [GET]", "methods: [GET, POST]")));
    expect(wider.governance.map((c) => c.text)).toEqual(["~ GitHubRead: methods GET → GET, POST"]);
    expect(wider.unchanged).not.toContain("no authority added");

    const any = semanticDiff(before, program(fetch(', methods: [GET])', ")")));
    expect(any.governance.map((c) => c.text)).toEqual(["~ GitHubRead: methods GET → any"]);
    expect(any.unchanged).not.toContain("no authority added");

    const narrower = semanticDiff(program(fetch("methods: [GET]", "methods: [GET, HEAD]")), before);
    expect(narrower.governance).toEqual([]);
    expect(narrower.behavior.map((c) => c.text)).toEqual(["- GitHubRead: methods GET, HEAD → GET (narrowed)"]);
    expect(narrower.unchanged).toContain("no authority added");

    const added = semanticDiff(program(fetch(', methods: [GET])', ")")), before);
    expect(added.governance).toEqual([]);
    expect(added.behavior.map((c) => c.text)).toEqual(["- GitHubRead: methods any → GET (narrowed)"]);
  });

  it("read a 0.4 program's methods as nothing, so a change to them is a change the diff cannot read", () => {
    const old = (methods: string): Program => program(fetch("mandate @ 0.5", "mandate @ 0.4").replace("methods: [GET]", methods));
    expect(semanticDiff(old("methods: [GET]"), old("methods: [GET, POST]")).governance.map((c) => c.text)).toEqual(["~ capability GitHubRead changed"]);
  });
});

describe("sandbox requirement 0.2", () => {
  const LOCK = {
    lock: "mandate/lock/0.5",
    modules: {},
    isolation: { floor: { confidential: "user_kernel" }, untrusted_network: "process", co_tenancy: { confidential: "forbidden" } },
    egress: { Reader: { "api.github.com": "github", "uploads.github.com": "github" }, Other: { "api.github.com": "other" } },
  } as unknown as Lock;
  const subject = { agent: "Reader", def: "sha256:0" };
  const model = (max: "public" | "internal" | "confidential" | "restricted"): CapVal => ({ ctor: "model.infer", effect: "Model", write: false, tier: "standard", maxClass: max });
  const v05 = { language: "mandate/0.5" } as const;

  it("is what a 0.5 program's agent gets: methods by host, the isolation it needs, and the credentials by name", () => {
    const r = sandboxRequirements(program(FETCH), {}, LOCK)["Reader"]!;
    expect(r).toEqual({
      format: "mandate/sandbox-requirement/0.2",
      subject: { agent: "Reader", def: check(FETCH, "mdt").hashes!.defs["Reader"] },
      filesystem: { read: [], write: [] },
      exec: [],
      network: { hosts: ["api.github.com"], methods: { "api.github.com": ["GET"] } },
      models: [{ tier: "standard", max_class: "confidential" }],
      ui: { desktop: false, clipboard: false },
      limits: { timeout_ms: 600000 },
      unbounded: [],
      isolation: { min: "user_kernel", co_tenancy: "forbidden", data_class: "confidential", untrusted_network: true },
      // Only the hosts the grant reaches: uploads.github.com is bound but not held.
      egress: { credentials: { "api.github.com": "github" } },
    });
    // Printed in the order the spec shows: the fields of 0.1 in their places, then isolation and egress.
    expect(Object.keys(r)).toEqual(["format", "subject", "filesystem", "exec", "network", "models", "ui", "limits", "unbounded", "isolation", "egress"]);
  });

  it("without a lock has no floor anywhere: process, sharing allowed, no credentials", () => {
    const r = sandboxRequirements(program(FETCH))["Reader"]!;
    expect([r.format, r.isolation, r.egress]).toEqual(["mandate/sandbox-requirement/0.2", { min: "process", co_tenancy: "allowed", data_class: "confidential", untrusted_network: true }, { credentials: {} }]);
  });

  it("takes the higher of the floor for its data class and, when it reaches a host, the floor for an untrusted network", () => {
    const at = (iso: object, caps: CapVal[]) => requirementFor(subject, caps, null, { ...v05, lock: { modules: {}, isolation: iso } as Lock }).isolation;
    expect(at({ floor: { confidential: "user_kernel" }, untrusted_network: "microvm" }, [model("confidential"), net()])?.min).toBe("microvm");
    expect(at({ floor: { confidential: "dedicated_host" }, untrusted_network: "microvm" }, [model("confidential"), net()])?.min).toBe("dedicated_host");
    // No host reached: the network's floor does not apply.
    expect(at({ untrusted_network: "microvm" }, [model("confidential")])).toEqual({ min: "process", co_tenancy: "allowed", data_class: "confidential", untrusted_network: false });
    // A floor applies to the class it names, and to no other.
    expect(at({ floor: { restricted: "microvm" } }, [model("confidential"), net()])?.min).toBe("process");
    expect(at({ floor: { internal: "microvm" }, co_tenancy: { internal: "forbidden" } }, [model("confidential")])).toMatchObject({ min: "process", co_tenancy: "allowed" });
    // The highest class among its models; with no model, public.
    expect(at({}, [model("internal"), model("restricted")])?.data_class).toBe("restricted");
    expect(at({ floor: { public: "user_kernel" } }, [])).toEqual({ min: "user_kernel", co_tenancy: "allowed", data_class: "public", untrusted_network: false });
  });

  it("merges grants of one host: the union of their methods, and any method once one has none", () => {
    const other: CapVal = { ...net(["POST"]), scope: ["api.github.com", "uploads.github.com"] };
    expect(requirementFor(subject, [net(["GET"]), other], null, v05).network).toEqual({ hosts: ["api.github.com", "uploads.github.com"], methods: { "api.github.com": ["GET", "POST"], "uploads.github.com": ["POST"] } });
    expect(requirementFor(subject, [net(["GET"]), net()], null, v05).network).toEqual({ hosts: ["api.github.com"], methods: {} });
  });

  it("is format 0.1, byte for byte, below 0.5 or without options, whatever the lock says", () => {
    const caps = [net(["GET"]), model("restricted")];
    const plain = JSON.stringify(requirementFor(subject, caps, 1000));
    expect(JSON.parse(plain).format).toBe("mandate/sandbox-requirement/0.1");
    for (const language of ["mandate/0.1", "mandate/0.2", "mandate/0.3", "mandate/0.4"] as LanguageVersion[]) {
      expect(JSON.stringify(requirementFor(subject, caps, 1000, { language, lock: LOCK }))).toBe(plain);
    }
    expect(JSON.stringify(requirementFor(subject, caps, 1000, { lock: LOCK }))).toBe(plain);
    // A program of 0.2 in the repository: the same requirements with the lock as without.
    const old = program(readRepo("fixtures/fixbug-target/fixbug.mdt"));
    expect(JSON.stringify(sandboxRequirements(old, {}, LOCK))).toBe(JSON.stringify(sandboxRequirements(old)));
  });
});
