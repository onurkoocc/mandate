import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CODES } from "../src/codes.js";
import { domainHash } from "../src/hash.js";
import { canonicalize } from "../src/json/jcs.js";
import { parseStrictJson } from "../src/json/strict-json.js";
import { LIMITS } from "../src/limits.js";
import { check } from "../src/check.js";
import { codes, minimal, readRepo } from "./helpers.js";

describe("JCS (RFC 8785)", () => {
  it("sorts members by UTF-16 code units (RFC 8785 §3.2.3 example)", () => {
    const value = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      "דּ": "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      "ö": "Latin Small Letter O With Diaeresis",
    };
    // Read keys from the text: Object.keys would move integer-like keys first.
    const keys = [...canonicalize(value).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map((m) => JSON.parse(`"${m[1]}"`) as string);
    expect(keys).toEqual(["\r", "1", "\u0080", "ö", "€", "😀", "דּ"]);
  });

  it("writes no insignificant whitespace and escapes like ECMAScript", () => {
    expect(canonicalize({ b: [1, true, null], a: " \n\"" })).toBe('{"a":" \\n\\"","b":[1,true,null]}');
  });

  it("separates hash domains", () => {
    expect(domainHash("program", {})).not.toBe(domainHash("def", {}));
    expect(domainHash("program", {})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("resource limits (§3.4)", () => {
  it("rejects JSON nested deeper than the limit", () => {
    const deep = "[".repeat(LIMITS.jsonDepth + 1) + "]".repeat(LIMITS.jsonDepth + 1);
    const r = parseStrictJson(deep);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(codes(r.diagnostics)).toEqual(["MDT-E0105"]);
  });

  it("rejects more than 64 definitions", () => {
    const defs: Record<string, unknown> = {};
    for (let i = 0; i <= LIMITS.definitions; i++) defs[`T${i}`] = { kind: "type", type: { ref: "Text" } };
    const r = check(JSON.stringify({ ...minimal(), defs }), "json");
    expect(codes(r.diagnostics)).toEqual(["MDT-E0105"]);
  });

  it("rejects source over 1 MiB", () => {
    const r = parseStrictJson(" ".repeat(LIMITS.sourceBytes + 1));
    expect(r.ok).toBe(false);
  });
});

describe("spec", () => {
  it("documents every diagnostic code the compiler emits", () => {
    const doc = readRepo("spec/diagnostics.md");
    for (const code of Object.keys(CODES)) expect(doc).toContain(code);
  });

  it("publishes a closed schema", () => {
    const schema = JSON.parse(readFileSync(new URL("../../spec/ir.schema.json", import.meta.url), "utf8")) as {
      additionalProperties: boolean;
    };
    expect(schema.additionalProperties).toBe(false);
  });
});
