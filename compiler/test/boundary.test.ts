// The compile-time surface of 0.5 (spec/boundary.md): `methods` of
// `net.https` is read from 0.5 and narrows like a scope; a program of 0.1 to
// 0.4 that writes it reads it as it always did, as nothing.

import { describe, expect, it } from "vitest";
import { check } from "../src/check.js";
import { capCovers, capFromCall, capsOf, readMethods, showCap, type CapVal } from "../src/check/caps.js";
import type { Expr, LanguageVersion, Program } from "../src/ir/types.js";
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
