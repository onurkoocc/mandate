// The compile-time surface of 0.5 (spec/boundary.md): `methods` of
// `net.https` is read from 0.5 and narrows like a scope; a program of 0.1 to
// 0.4 that writes it reads it as it always did, as nothing.

import { describe, expect, it } from "vitest";
import { check, checkSubprogram, load, loadModules } from "../src/check.js";
import { capCovers, capFromCall, capsOf, readMethods, showCap, type CapVal } from "../src/check/caps.js";
import { skeleton } from "../src/check/subprogram.js";
import { hashProgram } from "../src/hash.js";
import type { Json } from "../src/json/strict-json.js";
import type { Expr, LanguageVersion, Program } from "../src/ir/types.js";
import { LOCK_FORMATS, validateLock, type Lock } from "../src/lock.js";
import { requirementFor, sandboxRequirements } from "../src/target/sandbox.js";
import { authority, lockLimitsDiff, semanticDiff } from "../src/views/views.js";
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

describe("a sub-program of a 0.5 parent", () => {
  const { modules } = loadModules([{ file: "domain.mdt", text: readRepo("conformance/N01/domain.mdt"), kind: "mdt" }]);
  const edit = (s: string, from: string, to: string): string => {
    expect(s.includes(from), from).toBe(true);
    return s.replace(from, to);
  };
  let src = readRepo("conformance/N01/parent.mdt");
  src = edit(src, "mandate @ 0.4", "mandate @ 0.5");
  src = edit(src, "use std.{exec, fs, git, human, model}", "use std.{exec, fs, git, human, model, net}");
  src = edit(src, "capability Merge", 'capability GH     = net.https(hosts: ["api.github.com"], methods: [GET])\ncapability Merge');
  src = edit(src, "caps    M, Public, High, R, W, Merge", "caps    M, Public, High, R, W, Merge, GH");
  const parent = check(src, "mdt", { modules }).program!;
  const room = { left: { tokens: 50_000, steps: 100, agents: 10, "spend:USD": 10_000_000 }, time_left_ms: 1_800_000, writes: [] };
  const submit = (caps: string, base = hashProgram(skeleton(parent.module, 1, parent.language) as unknown as Json).program, extra = "") => {
    const sub = load(`mandate @ 0.5\n\nmodule example.parent.plan_1 @ 0.1\n\nuse example.parent\n\ncapability Wa = W.narrow("/work/a")\n${extra}\nworkflow Fix() -> Inferred<Text>\n  caps   ${caps}\n  budget { tokens: 2000, time: 10m, spend: 2 USD, steps: 10, agents: 2 }\n{\n  delegate Worker.fix(Item { name: "a" }) with caps Wa\n}\n`, "mdt").program!;
    const ops = Object.entries(sub.defs).map(([name, d]) => ({ op: "add" as const, path: `/defs/${name}`, value: d }));
    return checkSubprogram({ parent, modules, workflow: "Run", number: 1, base, ops, lead: "public", room });
  };

  it("is written in its parent's language, and a 0.4 parent's skeleton is as it was", () => {
    expect(parent.language).toBe("mandate/0.5");
    expect(skeleton("example.parent", 1, "mandate/0.5")).toEqual({ language: "mandate/0.5", module: "example.parent.plan_1", version: "0.1", uses: [{ module: "example.parent" }], defs: {} });
    expect(skeleton("example.parent", 1)).toEqual(skeleton("example.parent", 1, "mandate/0.4"));
    expect(skeleton("example.parent", 1, "mandate/0.3").language).toBe("mandate/0.4");
  });

  it("reads its parent's methods as its parent does: GET of the envelope's host fits, any method of it does not (E1706)", () => {
    const r = submit("M, R, Wa, GH");
    expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(r.ok).toBe(true);
    const any = submit("M, R, Wa, Any", undefined, 'capability Any = net.https(hosts: ["api.github.com"])\n');
    expect(any.diagnostics.filter((d) => d.severity === "error").map((d) => [d.code, d.facts?.["dimension"], d.facts?.["capability"]])).toEqual([["MDT-E1706", "capability", 'Any = net.https("api.github.com")']]);
    // A patch written against the 0.4 skeleton is written against another base.
    expect(submit("M, R, Wa, GH", hashProgram(skeleton(parent.module, 1) as unknown as Json).program).diagnostics.map((d) => d.code)).toEqual(["MDT-E0130"]);
  });
});

describe("lock 0.5", () => {
  const LOCK05 = JSON.parse(readRepo("fixtures/boundary/mandate.lock.json")) as Lock;
  const with_ = (o: Partial<Lock>): Lock => ({ ...structuredClone(LOCK05), ...o });
  const said = (lock: unknown): Array<[string, string]> => validateLock(lock).map((d) => [d.code, d.at.path ?? ""]);

  it("is read and written: host, isolation and egress", () => {
    expect(LOCK_FORMATS).toEqual(["mandate/lock/0.2", "mandate/lock/0.3", "mandate/lock/0.4", "mandate/lock/0.5"]);
    expect(validateLock(LOCK05)).toEqual([]);
    expect(check(FETCH, "mdt", { lock: LOCK05 }).diagnostics).toEqual([]);
  });

  it.each(["mandate/lock/0.4", "mandate/lock/0.3", "mandate/lock/0.2"])("refuses host, isolation and egress in a %s lock (E0140)", (format) => {
    const d = validateLock({ ...LOCK05, lock: format });
    expect(d.map((x) => [x.code, x.message, x.at.path])).toEqual(
      ["host", "isolation", "egress"].map((f) => ["MDT-E0140", `Lock field ${f} needs lock format mandate/lock/0.5, not ${format}.`, `/${f}`]),
    );
  });

  it("is closed: an unknown tool, level, data class or field, a version that is not one, an empty table, a credential name that is not one (E0140)", () => {
    expect(said(with_({ host: { node: "22.23.4", docker: "27" } as never }))).toEqual([["MDT-E0140", "/host"]]);
    expect(said(with_({ host: { node: "v22" } }))).toEqual([["MDT-E0140", "/host/node"]]);
    expect(said(with_({ host: {} }))).toEqual([["MDT-E0140", "/host"]]);
    expect(said(with_({ isolation: { floor: { restricted: "vm" } } as never }))).toEqual([["MDT-E0140", "/isolation/floor/restricted"]]);
    expect(said(with_({ isolation: { floor: { secret: "microvm" } } as never }))).toEqual([["MDT-E0140", "/isolation/floor"], ["MDT-E0140", "/isolation/floor"]]);
    expect(said(with_({ isolation: { co_tenancy: { restricted: "never" } } as never }))).toEqual([["MDT-E0140", "/isolation/co_tenancy/restricted"]]);
    expect(said(with_({ isolation: { min: "process" } as never }))).toEqual([["MDT-E0140", "/isolation"]]);
    expect(said(with_({ egress: { Reader: {} } }))).toEqual([["MDT-E0140", "/egress/Reader"]]);
    expect(said(with_({ egress: { Reader: { "api.github.com": "Bearer ghp_x" } } }))).toEqual([["MDT-E0140", "/egress/Reader/api.github.com"]]);
  });

  it("binds a credential only to a local agent's own hosts (E1802), and is refused with an earlier program where it would not apply (E1803)", () => {
    const r = check(FETCH, "mdt", { lock: with_({ egress: { Reader: { "api.github.com": "github", "uploads.github.com": "github" }, Nobody: { "api.github.com": "github" } } }) });
    expect(r.diagnostics.map((d) => [d.code, d.at.path, d.message])).toEqual([
      ["MDT-E1802", "/egress/Nobody", "The lock binds credentials to the requests of Nobody, which is not an agent of the program. A credential is bound only to an agent that runs in the runtime's sandbox, whose requests go through the egress proxy."],
      ["MDT-E1802", "/egress/Reader/uploads.github.com", "The lock binds credential github to Reader's requests to uploads.github.com, a host none of Reader's net.https capabilities holds."],
    ]);
    const old = check(fetch("mandate @ 0.5", "mandate @ 0.4"), "mdt", { lock: LOCK05 });
    expect(old.diagnostics.map((d) => [d.code, d.at.path, d.message])).toEqual([
      ["MDT-E1803", "/isolation", "Lock field isolation applies to a program of mandate/0.5 or later. This program is mandate/0.4: its sandbox requirements have no isolation level, so isolation would not apply. Write the program in mandate/0.5, or take isolation out of the lock."],
      ["MDT-E1803", "/egress", "Lock field egress applies to a program of mandate/0.5 or later. This program is mandate/0.4: its sandbox requirements have no credentials, so egress would not apply. Write the program in mandate/0.5, or take egress out of the lock."],
    ]);
    // host applies to a program of any version.
    expect(check(fetch("mandate @ 0.5", "mandate @ 0.4"), "mdt", { lock: { ...LOCK05, isolation: undefined, egress: undefined } as Lock }).diagnostics).toEqual([]);
  });
});

describe("view --against-lock of lock 0.5", () => {
  const LOCK05 = JSON.parse(readRepo("fixtures/boundary/mandate.lock.json")) as Lock;
  const p = (): Program => program(FETCH);
  const diff = (before: Partial<Lock>, after: Partial<Lock>) => {
    const v = semanticDiff(p(), p(), { before: { ...structuredClone(LOCK05), ...before }, after: { ...structuredClone(LOCK05), ...after } });
    return { governance: v.governance.map((c) => [c.path, c.text]), behavior: v.behavior.map((c) => [c.path, c.text]), added: !v.unchanged.includes("no authority added") };
  };

  it("adds nothing when the locks ask the same, or with locks that have none of it", () => {
    expect(diff({}, {})).toEqual({ governance: [], behavior: [], added: false });
    expect(lockLimitsDiff({ modules: {} }, { modules: {} })).toEqual({ governance: [], behavior: [] });
    // The same version written two ways, and sharing allowed written out or left out, are no change.
    expect(diff({ host: { node: "22.23" } }, { host: { node: "22.23.0" } })).toMatchObject({ governance: [], behavior: [] });
    expect(diff({ isolation: { co_tenancy: { internal: "allowed" } } }, { isolation: {} as never })).toMatchObject({ governance: [], behavior: [] });
  });

  it("calls a credential bound, added or changed, authority added; one taken away a behavior change", () => {
    expect(diff({ egress: undefined }, {})).toEqual({ governance: [["/egress/Reader/api.github.com", "+ egress: Reader's requests to api.github.com carry credential github"]], behavior: [], added: true });
    expect(diff({}, { egress: { Reader: { "api.github.com": "github_admin" } } }).governance).toEqual([["/egress/Reader/api.github.com", "~ egress: Reader's requests to api.github.com carry credential github → github_admin"]]);
    expect(diff({}, { egress: undefined })).toEqual({ governance: [], behavior: [["/egress/Reader/api.github.com", "- egress: Reader's requests to api.github.com carry credential github no more"]], added: false });
  });

  it("calls a floor lowered or taken away, and sharing allowed again, a governance change; raised or tightened, a behavior change", () => {
    const iso = (o: object): Partial<Lock> => ({ isolation: { ...LOCK05.isolation, ...o } as Lock["isolation"] });
    expect(diff({}, iso({ floor: { confidential: "process", restricted: "microvm" } })).governance).toEqual([["/isolation/floor/confidential", "~ isolation.floor.confidential: user_kernel → process (lowered)"]]);
    expect(diff({}, iso({ floor: { restricted: "microvm" } })).governance).toEqual([["/isolation/floor/confidential", "~ isolation.floor.confidential: user_kernel → no floor (lowered)"]]);
    expect(diff({}, iso({ untrusted_network: undefined })).governance).toEqual([]);
    expect(diff(iso({ untrusted_network: "microvm" }), {}).governance).toEqual([["/isolation/untrusted_network", "~ isolation.untrusted_network: microvm → process (lowered)"]]);
    expect(diff({}, iso({ co_tenancy: {} })).governance).toEqual([["/isolation/co_tenancy/restricted", "~ isolation.co_tenancy.restricted: forbidden → allowed (relaxed)"]]);
    expect(diff({}, iso({ floor: { confidential: "microvm", restricted: "dedicated_host" } }))).toEqual({
      governance: [],
      behavior: [
        ["/isolation/floor/confidential", "~ isolation.floor.confidential: user_kernel → microvm (raised)"],
        ["/isolation/floor/restricted", "~ isolation.floor.restricted: microvm → dedicated_host (raised)"],
      ],
      added: false,
    });
    expect(diff({}, iso({ co_tenancy: { restricted: "forbidden", confidential: "forbidden" } })).behavior).toEqual([["/isolation/co_tenancy/confidential", "~ isolation.co_tenancy.confidential: allowed → forbidden (tightened)"]]);
  });

  it("calls a least host version lowered or taken away a governance change, and raised a behavior change", () => {
    expect(diff({}, { host: { node: "22.9.0", bwrap: "0.11.0" } }).governance).toEqual([["/host/node", "~ host.node: 22.23.4 → 22.9.0 (lowered)"]]);
    expect(diff({}, { host: { node: "22.23.4" } }).governance).toEqual([["/host/bwrap", "~ host.bwrap: 0.11.0 → no minimum (lowered)"]]);
    expect(diff({}, { host: { node: "24.0.0", bwrap: "0.11.0" } })).toEqual({ governance: [], behavior: [["/host/node", "~ host.node: 22.23.4 → 24.0.0 (raised)"]], added: false });
    expect(diff({ host: { node: "22.23.4" } }, {}).behavior).toEqual([["/host/bwrap", "~ host.bwrap: no minimum → 0.11.0 (raised)"]]);
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
