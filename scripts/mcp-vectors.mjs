#!/usr/bin/env node
// Writes vectors/mcp/*.json: what the Node MCP server (`serveStdio` of
// bridge/src/mcp.ts, built to bridge/dist, the server of `mandate mcp` of the
// Node command line) writes on its standard output for each of a set of
// recorded conversations, byte for byte, so that the native `mandate mcp`
// (crates/mandate-cli/src/mcp) is held to it: crates/mandate-cli/tests/mcp.rs
// gives each conversation to the native server, in memory and as a process,
// and compares what it writes with what is stored here.
//
//   npm ci --ignore-scripts && npm run build && npm run build:wasm   (once)
//   node scripts/mcp-vectors.mjs                                     (what CI runs)
//
// Each file is one conversation: `args`, the arguments after `mandate` (the
// modules the server is started with, `--module <file>`, read here as the Node
// command line reads them); `input`, the bytes of standard input, as parts
// (`line`: a text and a line feed; `text`: a text; `hex`: bytes; `repeat` and
// `count`: a text that many times), so that a line that is too long, a byte
// that is not UTF-8 or a carriage return can be written down; `output`, what
// the server wrote, one element a line without its line feed (a line longer
// than 64 KiB as `{ sha256, bytes }`, `sha256:` and the hex SHA-256 of its
// UTF-8, and its length); and `tools_list`, the index of each output line that answers
// `tools/list`. Those lines are the one place where the two servers differ
// until slice B9: the Node server serves the frozen tool list, the native one
// the list of 0.7 from the door `mcp_tools`, so the test compares those lines
// with the frozen list put in the place of the list of 0.7.
//
// The conversations are the messages of bridge/test/mcp.test.ts and more:
// both protocol eras, every tool with a passing and a failing program, each
// view, each message limit, the lines the reader splits and those it skips,
// what JSON.parse and JSON.stringify do to numbers, names and lone
// surrogates, and the failures of a door. A call that 0.7 answers otherwise
// (`check` and `project` with `libraries`, the views `card` and `attention`,
// the sections `patterns` and `attention`, a view that is not one, whose
// message names the views of 0.7) is not here: the Rust test holds those.
//
// Every file is ASCII strict JSON (every character from U+007F up written as a
// \u escape, as in the other files of vectors/). Running it again writes the
// same bytes.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`bridge/dist/${path}`, root).href);
const { serveStdio } = await dist("mcp.js");
const { check, kindOf, loadModules } = await dist("index.js");

const read = (p) => readFileSync(new URL(p, root), "utf8");
const FIXBUG = read("fixtures/fixbug/fixbug.mdt");
const FIXBUG_TARGET = read("fixtures/fixbug-target/fixbug.mdt");
const SYSTEM = read("fixtures/system/acme.system.mdt");
const AUDIENCE = read("fixtures/system/audience.mdt");
const MIGRATE = read("fixtures/envelope/migrate-all.mdt");
const DOMAIN = read("fixtures/envelope/domain.mdt");
const MIGRATE_06 = read("fixtures/library/migrate-all.mdt");
const MIGRATE_06_LOCK = JSON.parse(read("fixtures/library/migrate-all.lock.json"));
const SHARED_06 = read("fixtures/library/shared.mdt");
const SUMMARIZE_06 = read("fixtures/library/summarize.mdt");
const MINIMAL_07 = read("fixtures/attention/minimal.mdt");
const STAGES_07 = read("fixtures/attention/stages.mdt");

const FIXBUG_IR = JSON.stringify(check(FIXBUG, "mdt").program);
const FIXBUG_BASE = check(FIXBUG, "mdt").hashes.program;
const AUDIENCE_BASE = check(AUDIENCE, "mdt", { modules: { "acme.system": check(SYSTEM, "mdt").program } }).hashes.program;

const V = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "test", version: "1" }, "io.modelcontextprotocol/clientCapabilities": {} };
const modern = (id, method, params = {}) => ({ jsonrpc: "2.0", id, method, params: { ...params, _meta: V } });
const tool = (id, name, args) => modern(id, "tools/call", { name, arguments: args });
const legacy = (id, method, params) => ({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
const init = (id, protocolVersion) => legacy(id, "initialize", { protocolVersion, capabilities: {}, clientInfo: { name: "old", version: "1" } });

/** A part of the input: one message as a line. */
const msg = (v) => ({ line: JSON.stringify(v) });
/** A part of the input: a text as a line, as it is written. */
const raw = (text) => ({ line: text });

/** A message as a line, where the string "@@" in it stands for `parts`: a long text written as its repetition. */
function lineWith(v, parts) {
  const [head, tail] = JSON.stringify(v).split('"@@"');
  return [{ text: head }, ...parts, { line: tail }];
}

/** An array of `n` zeros, as parts. */
const zeros = (n) => [{ text: "[" }, { repeat: "0,", count: n - 1 }, { text: "0]" }];

/** `n` levels of `{"k":` around `inner`. */
const nestedObject = (n, inner) => `${'{"k":'.repeat(n)}${inner}${"}".repeat(n)}`;

/** A message of exactly `bytes` bytes: a ping with a member padded to that length. */
function sized(id, bytes) {
  const head = `{"jsonrpc":"2.0","id":${id},"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},"pad":"`;
  const tail = '"}}';
  return [{ text: head }, { repeat: "a", count: bytes - head.length - tail.length }, { line: tail }];
}

/** The conversations: [name, about, args, parts]. */
const CONVERSATIONS = [
  [
    "modern-protocol",
    "the modern era: discover, list, ping, a method the server does not have, a version it does not speak, no version, and messages that are not requests",
    [],
    [
      modern(1, "server/discover"),
      modern(2, "tools/list"),
      modern(3, "ping"),
      modern(4, "resources/list"),
      modern(5, "prompts/list"),
      { jsonrpc: "2.0", id: 6, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
      { jsonrpc: "2.0", id: 7, method: "tools/list", params: {} },
      { jsonrpc: "2.0", id: 8, method: "server/discover" },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 9, method: 5 },
      { jsonrpc: "1.0", id: 10, method: "ping" },
      [],
      [modern(12, "ping")],
      "text",
      null,
      7,
      0,
      false,
      { id: 11 },
      { jsonrpc: "2.0", id: 13, method: "ping", params: { _meta: { "io.modelcontextprotocol/protocolVersion": 2026 } } },
      { jsonrpc: "2.0", id: 14, method: "ping", params: [1, 2] },
      { jsonrpc: "2.0", id: 15, method: "ping", params: { _meta: [V] } },
      { jsonrpc: "2.0", id: 16, method: "ping", params: "text" },
      { jsonrpc: "2.0", id: 17, method: "ping", params: { _meta: { ...V, "io.modelcontextprotocol/protocolVersion": "2025-06-18" } } },
      modern(18, "no/such/method"),
      { jsonrpc: "2.0", id: null, method: "ping", params: { _meta: V } },
      { jsonrpc: "2.0", method: "ping", params: { _meta: V } },
    ].map(msg),
  ],
  [
    "legacy-sessions",
    "the legacy handshake in each of its versions, then calls in the session it opens",
    [],
    [
      { jsonrpc: "2.0", id: 0, method: "tools/list", params: {} },
      ...["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2020-01-01", undefined, null, ["2025-03-26"], 20250618].map((v, i) => init(i + 1, v)),
      init(20, "2025-06-18"),
      { jsonrpc: "2.0", method: "notifications/initialized" },
      legacy(21, "tools/list"),
      legacy(22, "ping"),
      legacy(23, "tools/call", { name: "mandate.check", arguments: { source: FIXBUG } }),
      legacy(24, "tools/call", { name: "mandate.explain", arguments: { code: "E9999" } }),
      legacy(25, "tools/call", { name: "mandate.spec", arguments: { section: "4" } }),
      legacy(26, "server/discover"),
      legacy(27, "resources/list"),
      modern(28, "tools/list"),
      tool(29, "mandate.explain", { code: "E0130" }),
      { jsonrpc: "2.0", id: 30, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
    ].map(msg),
  ],
  [
    "initialize-as-notification",
    "an initialize without an id is answered (with id null) and opens the session; another notification is not answered",
    [],
    [{ jsonrpc: "2.0", method: "initialize" }, { jsonrpc: "2.0", method: "notifications/cancelled", params: {} }, legacy(1, "tools/list"), legacy(2, "ping")].map(msg),
  ],
  [
    "check",
    "mandate.check: passing and failing programs, as text and as IR, with modules and locks, and arguments it refuses",
    [],
    [
      tool(20, "mandate.check", { source: FIXBUG }),
      tool(21, "mandate.check", { source: FIXBUG_IR }),
      tool(22, "mandate.check", { source: FIXBUG.replace("tests = delegate TestWriter.regression(issue)", "tests = delegate TestWriter.regression(issue) with caps SrcWrite") }),
      tool(23, "mandate.check", { source: "mandate @ 0.5\n\nnot a program\n" }),
      tool(24, "mandate.check", { source: AUDIENCE }),
      tool(25, "mandate.check", { source: AUDIENCE, modules: [SYSTEM] }),
      tool(26, "mandate.check", { source: AUDIENCE, modules: ["not a module"] }),
      tool(27, "mandate.check", { source: MIGRATE, modules: [DOMAIN] }),
      tool(28, "mandate.check", { source: FIXBUG, lock: { lock: "mandate/lock/0.5", modules: {} } }),
      tool(29, "mandate.check", { source: FIXBUG, lock: "text" }),
      tool(30, "mandate.check", {}),
      tool(31, "mandate.check", { source: 5 }),
      tool(32, "mandate.check", { source: FIXBUG, kind: "json" }),
      tool(33, "mandate.check", { source: "{ not json", kind: "json" }),
      tool(34, "mandate.check", { source: FIXBUG, kind: "yaml" }),
      tool(35, "mandate.check", { source: `  \n${FIXBUG_IR}` }),
      tool(36, "mandate.check", { source: FIXBUG, lock: 0 }),
      tool(37, "mandate.check", { source: FIXBUG, lock: null }),
      tool(38, "mandate.check", { source: FIXBUG, modules: [] }),
      tool(39, "mandate.check", { source: FIXBUG, modules: "none" }),
      tool(40, "mandate.check", { source: FIXBUG, modules: [SYSTEM, 5] }),
      tool(41, "mandate.check", { source: MIGRATE_06 }),
      tool(42, "mandate.check", { source: MIGRATE_06, lock: MIGRATE_06_LOCK }),
      tool(43, "mandate.check", { source: SUMMARIZE_06, modules: [SHARED_06] }),
      tool(44, "mandate.check", { source: SUMMARIZE_06 }),
      tool(45, "mandate.check", { source: MINIMAL_07 }),
      tool(46, "mandate.check", { source: STAGES_07 }),
      tool(47, "mandate.check", { source: "" }),
    ].map(msg),
  ],
  [
    "explain",
    "mandate.explain: a code with and without its prefix, a code of 0.6 and 0.7, codes it does not know, and arguments it refuses",
    [],
    [
      tool(40, "mandate.explain", { code: "E0320" }),
      tool(41, "mandate.explain", { code: "MDT-E0130" }),
      tool(42, "mandate.explain", { code: "E9999" }),
      tool(43, "mandate.explain", {}),
      tool(44, "mandate.explain", { code: 7 }),
      tool(45, "mandate.explain", { code: "E1601" }),
      tool(46, "mandate.explain", { code: "W0504" }),
      tool(47, "mandate.explain", { code: "mdt-e0320" }),
      tool(48, "mandate.explain", { code: "" }),
      tool(49, "mandate.explain", { code: "E0320", modules: ["not a module"] }),
    ].map(msg),
  ],
  [
    "apply-patch",
    "mandate.apply_patch: a patch that needs approval, one that does not, a stale base, operations it refuses, and programs that do not load",
    [],
    [
      tool(50, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "replace", path: "/defs/FixBug/budget/spend/micros", value: 60_000_000 }] }),
      tool(51, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "replace", path: "/defs/RepoRead/value/args/0/value/value", value: "/work/repo/src" }] }),
      tool(52, "mandate.apply_patch", { source: FIXBUG_IR, base: "sha256:0000", ops: [] }),
      tool(53, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [] }),
      tool(54, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "remove", path: "/no/such/path" }] }),
      tool(55, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: "none" }),
      tool(56, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }], modules: [SYSTEM] }),
      tool(57, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }] }),
      tool(58, "mandate.apply_patch", {}),
      tool(59, "mandate.apply_patch", { source: FIXBUG, base: FIXBUG_BASE, ops: [] }),
      tool(60, "mandate.apply_patch", { source: FIXBUG_IR, ops: [] }),
      tool(61, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE }),
      tool(62, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: [] }),
      tool(63, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [5] }),
      tool(64, "mandate.apply_patch", { source: FIXBUG_IR, base: FIXBUG_BASE, ops: [{ op: "move", path: "/version" }] }),
    ].map(msg),
  ],
  [
    "caps-of",
    "mandate.caps_of: an agent, a workflow, a name that is neither, a missing name, and a program that does not check",
    [],
    [
      tool(60, "mandate.caps_of", { source: FIXBUG, name: "Implementer" }),
      tool(61, "mandate.caps_of", { source: FIXBUG, name: "FixBug" }),
      tool(62, "mandate.caps_of", { source: FIXBUG, name: "NoSuchName" }),
      tool(63, "mandate.caps_of", { source: FIXBUG }),
      tool(64, "mandate.caps_of", { source: "mandate @ 0.5\n\nnot a program\n", name: "X" }),
      tool(65, "mandate.caps_of", { source: AUDIENCE, modules: [SYSTEM], name: "Audience" }),
      tool(66, "mandate.caps_of", { source: MIGRATE_06, name: "MigrateAll" }),
      tool(67, "mandate.caps_of", { name: "FixBug" }),
    ].map(msg),
  ],
  [
    "project",
    "mandate.project: each view of 0.1 to 0.6 of programs of 0.5, 0.6 and 0.7, with modules and a lock, a diff, and arguments it refuses",
    [],
    [
      ...["architecture", "authority", "cost"].map((view, i) => tool(70 + i, "mandate.project", { source: FIXBUG, view })),
      tool(73, "mandate.project", { source: FIXBUG, view: "diff" }),
      tool(74, "mandate.project", { source: FIXBUG, view: "diff", before: FIXBUG_TARGET }),
      tool(76, "mandate.project", { source: AUDIENCE, modules: [SYSTEM], view: "authority" }),
      tool(77, "mandate.project", { source: MIGRATE, modules: [DOMAIN], view: "architecture" }),
      tool(78, "mandate.project", {}),
      ...["architecture", "authority", "cost"].map((view, i) => tool(80 + i, "mandate.project", { source: MIGRATE_06, view, lock: MIGRATE_06_LOCK })),
      tool(83, "mandate.project", { source: MIGRATE_06, view: "diff", before: MIGRATE, modules: [DOMAIN] }),
      tool(84, "mandate.project", { source: SUMMARIZE_06, modules: [SHARED_06], view: "authority" }),
      tool(85, "mandate.project", { source: MINIMAL_07, view: "architecture" }),
      tool(86, "mandate.project", { source: STAGES_07, view: "cost" }),
      tool(87, "mandate.project", { source: FIXBUG, view: "cost", lock: null }),
      tool(88, "mandate.project", { source: FIXBUG, view: "diff", before: "not a program" }),
      tool(89, "mandate.project", { source: "not a program", view: "architecture" }),
    ].map(msg),
  ],
  [
    "spec",
    "mandate.spec: the whole core specification, numbered sections written in several ways, and sections that are not there",
    [],
    [
      tool(80, "mandate.spec", {}),
      tool(81, "mandate.spec", { section: "4" }),
      tool(82, "mandate.spec", { section: "999" }),
      tool(83, "mandate.spec", { section: 4 }),
      tool(84, "mandate.spec", { section: " 7.2 " }),
      tool(85, "mandate.spec", { section: "4." }),
      tool(86, "mandate.spec", { section: "" }),
      tool(87, "mandate.spec", { section: null }),
      tool(88, "mandate.spec", { section: 7.2 }),
      tool(89, "mandate.spec", { section: ["7", "2"] }),
      tool(90, "mandate.spec", { section: "\u3000\ufeff3\u00a0" }),
    ].map(msg),
  ],
  [
    "not-tools",
    "tools/call of a tool that is not there, without a name, with arguments that are not an object, and with an empty list of modules",
    [],
    [
      tool(90, "mandate.nothing", {}),
      modern(91, "tools/call", { arguments: {} }),
      modern(92, "tools/call", { name: "mandate.explain", arguments: "text" }),
      modern(93, "tools/call", { name: "mandate.explain" }),
      modern(94, "tools/call", { name: "mandate.explain", arguments: ["E0320"] }),
      modern(95, "tools/call", { name: 7 }),
      modern(96, "tools/call", { name: ["mandate", "check"] }),
      modern(97, "tools/call", { name: { a: 1 } }),
      modern(98, "tools/call", { name: null }),
      modern(99, "tools/call", { name: "mandate.spec", arguments: { section: "4", modules: [] } }),
      modern(100, "tools/call", { name: "MANDATE.SPEC", arguments: {} }),
    ].map(msg),
  ],
  [
    "server-modules",
    "the modules the server is started with (`mandate mcp --module <file>`), which every call's program may import, and a call's own beside them",
    ["--module", "fixtures/system/acme.system.mdt"],
    [
      tool(1, "mandate.check", { source: AUDIENCE }),
      tool(2, "mandate.apply_patch", { source: AUDIENCE, base: AUDIENCE_BASE, ops: [{ op: "replace", path: "/version", value: "0.2" }] }),
      tool(3, "mandate.project", { source: AUDIENCE, view: "authority" }),
      tool(4, "mandate.caps_of", { source: AUDIENCE, name: "Audience" }),
      tool(5, "mandate.check", { source: MIGRATE, modules: [DOMAIN] }),
      tool(6, "mandate.check", { source: AUDIENCE, modules: [SYSTEM] }),
    ].map(msg),
  ],
  [
    "lines",
    "how lines are split and read: CRLF, a lone CR, blank lines and lines of white space, a byte order mark, bytes that are not UTF-8, a last line without a break",
    [],
    [
      { text: `${JSON.stringify(modern(1, "ping"))}\r\n` },
      { text: `${JSON.stringify(modern(2, "ping"))}\r` },
      { text: `${JSON.stringify(modern(3, "ping"))}\n\n\n` },
      { text: " \t \r\n" },
      raw("\u00a0\u3000\u2028"),
      raw("\ufeff"),
      raw(`\ufeff${JSON.stringify(modern(4, "ping"))}`),
      raw(`  ${JSON.stringify(modern(5, "ping"))}  `),
      raw("{ not json"),
      raw('{"jsonrpc":"2.0","id":6,"method":"ping",}'),
      { text: '{"jsonrpc":"2.0","id":7,"method":"no/' },
      { hex: "ff" },
      { line: `such","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}` },
      { text: '{"jsonrpc":"2.0","id":8,"method":"x' },
      { hex: "e282" },
      { line: `","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}` },
      // Each ill-formed sequence is U+FFFD as Node's decoder makes it (its maximal subparts): an overlong form, a
      // surrogate, a code point past U+10FFFF, a sequence cut short, a byte that only continues one.
      ...["c080", "eda080", "f4908080", "f09f98", "80", "e2", "f0"].flatMap((bytes, i) => [
        { text: `{"jsonrpc":"2.0","id":${12 + i},"method":"a` },
        { hex: bytes },
        { line: `b","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}` },
      ]),
      { hex: "ff" },
      { line: JSON.stringify(modern(9, "ping")) },
      { text: '{"jsonrpc":"2.0","id":10,"method":"\u00e9\u20ac\ud83d\ude00","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}\n' },
      { text: JSON.stringify(modern(11, "ping")) },
    ],
  ],
  [
    "json-values",
    "what JSON.parse and JSON.stringify do: numbers as ids, ids that are not numbers or strings, a name given twice, names that are array indices, lone surrogates, control characters and U+2028 echoed back",
    [],
    [
      raw('{"jsonrpc":"2.0","id":1.0,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":1e21,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":-0,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":1e400,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":0.1,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":12345678901234567890,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":-1.5e-7,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":{"b":1,"2":true,"a":[null],"1":"x"},"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":[1,"two",{}],"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":true,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":"\\ud800","method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":"a\\u0000\\u001f\\u007f\\u2028\\u2029\\"\\\\\\/b","method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":20,"id":21,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":22,"method":"x\\udc00y","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":23,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-\\ud83d"}}}'),
      raw('{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"mandate.\\ud83d","_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"mandate.explain","arguments":{"code":"E\\udbff"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"mandate.spec","arguments":{"section":"\\ud83d\\ude00\\ud83d"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw(`{"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"mandate.caps_of","arguments":{"source":${JSON.stringify(FIXBUG)},"name":"Fix\\udc00Bug"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw('{"jsonrpc":"2.0","id":28,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":"mandate @ 0.5\\n\\ud800"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":29,"method":"tools/call","params":{"name":"mandate.explain","arguments":{"code":"E0320","modules":["\\udfff"]},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","id":30,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},"__proto__":{"x":1}}}'),
      raw('{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"mandate.explain","arguments":{"code":"E0320","code":"E0130"},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
      raw('{"jsonrpc":"2.0","method":"tools/call","id":32,"params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},"arguments":{"code":"E0320"},"name":"mandate.explain"}}'),
    ],
  ],
  [
    "door-failures",
    "what a door cannot be asked (a number that is not an integer, -0, a number too large, a lone surrogate in a value or a name) and what a door refuses: Internal errors in the bridge's words",
    [],
    [
      raw(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":{"lock":"mandate/lock/0.5","n":1.5}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":{"a/b~c":[-0]}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":{"x":1e400}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":{"x":{"\\ud800":1}}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":{"x":9007199254740992}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"mandate.apply_patch","arguments":{"source":${JSON.stringify(FIXBUG_IR)},"base":"${FIXBUG_BASE}","ops":[{"op":"replace","path":"/version","value":0.5}]},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"mandate.project","arguments":{"source":${JSON.stringify(FIXBUG)},"view":"cost","lock":{"lock":"mandate/lock/0.5","modules":{},"x":-0}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":${JSON.stringify(FIXBUG)},"lock":[1,[2,3.25]]},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"mandate.apply_patch","arguments":{"source":${JSON.stringify(FIXBUG_IR)},"base":"${FIXBUG_BASE}","ops":[{"op":"replace","path":"/version","value":"0.2","extra":1}]},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw('{"jsonrpc":"2.0","id":{"z":1},"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":"x","lock":{"y":0.5}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}'),
    ],
  ],
  [
    "limits",
    "the message limits: a line of exactly the byte limit and one byte more, a 2 MiB request, a 1 000 000-element array, arrays and nestings over and at their limits, and which of two breaches is reported; the server goes on after each",
    [],
    [
      ...sized(1, 1024 * 1024),
      ...sized(2, 1024 * 1024 + 1),
      ...lineWith(tool(3, "mandate.check", { source: "@@" }), [{ text: '"' }, { repeat: "a", count: 2 * 1024 * 1024 }, { text: '"' }]),
      ...lineWith(tool(4, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: "@@" }), zeros(1_000_000)),
      ...lineWith(tool(5, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: "@@" }), zeros(10_001)),
      ...lineWith(tool(6, "mandate.apply_patch", { source: "{}", base: "sha256:0", ops: "@@" }), zeros(10_000)),
      raw(`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":"x","lock":${nestedObject(69, "1")}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"mandate.check","arguments":{"source":"x","lock":${nestedObject(68, "1")}},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"}}}`),
      raw(`{"jsonrpc":"2.0","id":9,"method":"ping","params":{"x":${"[".repeat(500_000)}${"]".repeat(500_000)}}}`),
      raw(`{"jsonrpc":"2.0","id":10,"method":"ping","params":{"x":${"[".repeat(500_000)}${"]".repeat(499_999)}}}`),
      { text: `{"jsonrpc":"2.0","id":11,"method":"ping","params":{"b":${"[".repeat(80)}${"]".repeat(80)},"a":` },
      ...zeros(10_001),
      { line: "}}" },
      { text: '{"jsonrpc":"2.0","id":12,"method":"ping","params":{"b":' },
      ...zeros(10_001),
      { line: `,"7":${"[".repeat(80)}${"]".repeat(80)}}}` },
      raw(`{"jsonrpc":"2.0","id":13,"method":"ping","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28"},"a":${"[".repeat(80)}${"]".repeat(80)},"a":1}}`),
      raw(`{"jsonrpc":"2.0","id":"s","method":"ping","params":{"a/b~c":{"\\ud800":${"[".repeat(80)}${"]".repeat(80)}}}}`),
      raw(`{"id":[1],"x":${"[".repeat(80)}${"]".repeat(80)}}`),
      raw(`[${"[".repeat(80)}${"]".repeat(80)}]`),
      raw(`${"[".repeat(80)}{ not json`),
      msg(modern(14, "ping")),
    ],
  ],
];

/** The bytes of the parts. */
function bytesOf(parts) {
  return Buffer.concat(
    parts.map((p) => {
      if (p.line !== undefined) return Buffer.from(`${p.line}\n`, "utf8");
      if (p.text !== undefined) return Buffer.from(p.text, "utf8");
      if (p.hex !== undefined) return Buffer.from(p.hex, "hex");
      return Buffer.from(p.repeat.repeat(p.count), "utf8");
    }),
  );
}

/** The parts as the file writes them: a long text as a repetition where it is one. */
function stored(parts) {
  return parts.flatMap((p) => {
    if (p.text === undefined && p.line === undefined) return [p];
    const text = p.line ?? p.text;
    const key = p.line !== undefined ? "line" : "text";
    if (text.length <= 4096) return [{ [key]: text }];
    // A long text is written as runs of one character where it has them, so that the file stays small.
    const out = [];
    let i = 0;
    while (i < text.length) {
      let j = i;
      while (j < text.length && text[j] === text[i]) j++;
      if (j - i >= 64) {
        out.push({ repeat: text[i], count: j - i });
        i = j;
      } else {
        let k = i;
        // A run of plain text up to the next long run of one character.
        while (k < text.length) {
          let r = k;
          while (r < text.length && text[r] === text[k]) r++;
          if (r - k >= 64) break;
          k = r;
        }
        out.push({ text: text.slice(i, k) });
        i = k;
      }
    }
    if (key === "line") out.push({ text: "\n" });
    return out;
  });
}

/** What the Node server writes for `input`, started with the modules of `args`, as `mandate mcp` starts it. */
async function serve(args, input) {
  const files = [];
  for (let i = 0; i < args.length; i += 2) if (args[i] === "--module") files.push(args[i + 1]);
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: read(file), kind: kindOf(file) })));
  if (problems.length) throw new Error(`a module does not load: ${JSON.stringify(problems)}`);
  const out = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      out.push(Buffer.from(chunk));
      done();
    },
  });
  await serveStdio(Readable.from([input]), output, modules);
  return Buffer.concat(out).toString("utf8");
}

const LONG_LINE = 64 * 1024;
const ascii = (text) => text.replace(/[^\x00-\x7e]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

const dir = new URL("vectors/mcp/", root);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let lines = 0;
for (const [name, about, args, parts] of CONVERSATIONS) {
  const written = await serve(args, bytesOf(parts));
  if (!written.endsWith("\n") && written !== "") throw new Error(`${name}: the output does not end with a line feed`);
  const answers = written === "" ? [] : written.slice(0, -1).split("\n");
  const toolsList = [];
  answers.forEach((l, i) => {
    const a = JSON.parse(l);
    if (a.result && Array.isArray(a.result.tools)) toolsList.push(i);
  });
  const output = answers.map((l) => (Buffer.byteLength(l, "utf8") > LONG_LINE ? { sha256: sha256(l), bytes: Buffer.byteLength(l, "utf8") } : l));
  const file = { format: "mandate/vectors/mcp/0.1", name, about, args: ["mcp", ...args], input: stored(parts), output, tools_list: toolsList };
  const text = ascii(JSON.stringify(file, null, 1));
  if (!bytesOf(stored(parts)).equals(bytesOf(parts))) throw new Error(`${name}: the stored input is not the input`);
  writeFileSync(new URL(`${name}.json`, dir), `${text}\n`);
  lines += answers.length;
}
const names = readdirSync(dir).length;
process.stdout.write(`mcp: ${names} conversations, ${lines} answers\n`);
