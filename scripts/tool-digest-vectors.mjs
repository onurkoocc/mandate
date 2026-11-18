#!/usr/bin/env node
// Writes vectors/tool-digest/tool-schema-digest.json: the schema digest of MCP tools that
// the runtime's own function, `schemaDigest` of runtime/src/mcp-client.ts
// (built to runtime/dist), gives, so that the door `tool_schema_digest` of the
// Rust compiler (crates/mandate-check/src/json_doors/connectors.rs) is held to
// it byte for byte. The Rust test crates/mandate-check/tests/tool_schema_digest.rs
// gives each `tool` to the door and compares the digest, and the canonical text
// that is digested.
//
//   npm ci --ignore-scripts && npm run build    (once: it reads runtime/dist)
//   node scripts/tool-digest-vectors.mjs          (what CI runs)
//
// Each vector is the JSON text of a tool, written by hand below, the way a
// server's `tools/list` may write it (a number as 1.0 or 1e2, a name with an
// escape, members in any order, a member twice), and the digest the function
// gives for `JSON.parse` of that text: the runtime holds the parsed value, so
// this is the value it digests. `canonical` is the text the function hashes
// (the runtime's own `canonical` of the object it builds), and the script
// checks that the digest is the SHA-256 of it. A text the door must refuse is
// in `refused`, with the reason; the script checks that `JSON.parse` agrees
// (it throws, or gives a value that is no object). Running it again writes the
// same bytes: there is no clock and no randomness.

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const dist = (path) => import(new URL(`runtime/dist/${path}`, root).href);
const { schemaDigest } = await dist("mcp-client.js");
const { canonical } = await dist("values.js");

/** `canonical` of what `schemaDigest` builds from a parsed tool, written out here again to name the text it hashes. */
function hashedText(tool) {
  const v = { name: tool.name, inputSchema: tool.inputSchema };
  if (tool.outputSchema !== undefined) v.outputSchema = tool.outputSchema;
  return canonical(v);
}

const sha256 = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

// A nested schema: `n` levels of `{ "type": "object", "properties": { "k": … } }`.
function nested(n) {
  let s = '{"type":"string"}';
  for (let i = 0; i < n; i++) s = `{"type":"object","properties":{"k${i}":${s}},"required":["k${i}"]}`;
  return s;
}

// A schema of `n` properties named p000, p001, … in descending order, to be sorted.
function wide(n) {
  const props = [];
  for (let i = n - 1; i >= 0; i--) props.push(`"p${String(i).padStart(3, "0")}":{"type":"integer","minimum":${i}}`);
  return `{"type":"object","properties":{${props.join(",")}}}`;
}

const tool = (name, input, output) => `{"name":${name},"inputSchema":${input}${output === undefined ? "" : `,"outputSchema":${output}`}}`;
const OBJECT = '{"type":"object"}';

/** [name, text, why it is there] */
const vectors = [
  ["minimal, no outputSchema", tool('"echo"', OBJECT), "the member is left out, not null"],
  ["with outputSchema", tool('"echo"', OBJECT, '{"type":"object","properties":{"text":{"type":"string"}}}'), "the member is digested"],
  ["outputSchema is the empty object", tool('"echo"', OBJECT, "{}"), "present and empty is not absent"],
  ["outputSchema is null", tool('"echo"', OBJECT, "null"), "present and null is digested as null"],
  ["inputSchema is the empty object", tool('"echo"', "{}"), "an empty object"],
  ["empty objects and arrays inside", tool('"echo"', '{"type":"object","properties":{},"required":[],"default":{},"examples":[{},[]]}'), "empty containers keep their form"],
  ["members in the order of a server", '{"outputSchema":{"type":"object","required":["b","a"],"properties":{"b":{"type":"string"},"a":{"type":"string"}}},"inputSchema":{"properties":{"z":{"type":"string"},"a":{"type":"string"}},"type":"object"},"name":"echo"}', "the members are sorted, an array is not"],
  ["the same tool in the order of the digest", '{"inputSchema":{"properties":{"a":{"type":"string"},"z":{"type":"string"}},"type":"object"},"name":"echo","outputSchema":{"properties":{"a":{"type":"string"},"b":{"type":"string"}},"required":["b","a"],"type":"object"}}', "the digest does not depend on the order of members"],
  ["other members of the tool are not digested", '{"name":"echo","title":"Echo","description":"Says it back.","annotations":{"readOnlyHint":true},"_meta":{"k":1},"inputSchema":{"type":"object"}}', "description, title, annotations and _meta are left out"],
  ["whitespace in the text", ' \n{ "name" : "echo" ,\t"inputSchema" : { "type" : "object" ,\r\n "properties" : { } } } \n', "the text is not the digest's"],
  ["no inputSchema", '{"name":"echo"}', "an undefined member is left out"],
  ["no name", '{"inputSchema":{"type":"object"}}', "an undefined member is left out"],
  ["no member at all", "{}", "the empty object is digested"],
  ["a member given twice", '{"name":"first","name":"echo","inputSchema":{"type":"object","a":1,"a":2}}', "JSON.parse takes the last"],
  ["__proto__ is a member", '{"name":"echo","inputSchema":{"__proto__":{"type":"string"},"type":"object"}}', "an own member like any other"],
  ["nested schemas", tool('"search"', '{"type":"object","properties":{"query":{"type":"string","minLength":1},"filters":{"type":"array","items":{"type":"object","properties":{"field":{"enum":["a","b","c"]},"value":{"anyOf":[{"type":"string"},{"type":"number"},{"type":"null"}]}},"required":["field"],"additionalProperties":false}}},"required":["query"],"$defs":{"id":{"type":"string","pattern":"^[a-z]+$"}}}', '{"type":"object","properties":{"hits":{"type":"array","items":{"$ref":"#/$defs/hit"}}},"$defs":{"hit":{"type":"object","properties":{"id":{"type":"string"},"score":{"type":"number"}}}}}'), "objects in arrays in objects, and a $ref"],
  ["forty levels deep", tool('"deep"', nested(40)), "depth"],
  ["four hundred objects deep", tool('"deeper"', nested(200)), "depth the door still reads (the limit is 512)"],
  ["three hundred properties", tool('"wide"', wide(300)), "many members to sort"],
  ["a name with letters outside ASCII", tool('"café"', '{"type":"object","properties":{"café":{"type":"string","description":"é"}}}'), "UTF-8 in a name and in a member name"],
  ["a name in another script", tool('"日本語のツール"', '{"type":"object","properties":{"名前":{"type":"string","default":"山田"}}}'), "BMP characters outside Latin"],
  ["a name of astral characters", tool('"𝒳-tool-😀"', '{"type":"object","properties":{"😀":{"type":"string"},"𝒳":{"type":"string"}}}'), "characters of two UTF-16 units"],
  ["members sorted by UTF-16, not by code point", '{"name":"order","inputSchema":{"￿":1,"𐀀":2,"퟿":3,"":4,"é":5,"z":6,"A":7}}', "𐀀 (U+10000, units D800 DC00) sorts before U+FFFF; by code point it sorts after"],
  ["the same text with its characters escaped", '{"\\u006eame":"caf\\u00e9","inputSchema":{"type":"object","note":"\\ud83d\\ude00 \\u00e9 \\/"}}', "an escape reads as the character, and is written back as the character"],
  ["a string that JSON writes with escapes", '{"name":"esc","inputSchema":{"a":"quote \\" backslash \\\\ solidus \\/ tab \\t newline \\n return \\r bell \\u0007 backspace \\b formfeed \\f nul \\u0000 unit separator \\u001f del \\u007f","b":"\\u2028 \\u2029 </script> < > & \'"}}', "control characters are escaped as JSON does (lower case \\u00xx), \\u2028 and \\u2029 and DEL are not"],
  ["a lone surrogate", '{"name":"lone","inputSchema":{"high":"\\ud800","low":"\\udc00","pair":"\\ud83d\\ude00","swapped":"\\ude00\\ud83d","tail":"x\\ud83d","\\ud800":1}}', "JSON.parse keeps it and JSON.stringify writes it as a lower-case \\u escape"],
  ["empty strings", '{"name":"","inputSchema":{"":"","type":""}}', "an empty name and member"],
  ["integers", tool('"n"', '{"minimum":0,"maximum":100,"multipleOf":5,"default":-7,"enum":[1,2,3,10,100,1000000]}'), "plain integers"],
  ["numbers JSON writes differently from their text", tool('"n"', '{"enum":[1.0,2.50,1e2,1E+2,1e-2,0.10,100.000,-0,-0.0,0e0,0.0e5,1.5E2,123e-2]}'), "1.0 is 1, 2.50 is 2.5, 1e2 and 1E+2 are 100, 0.10 is 0.1, -0 is 0"],
  ["numbers at the edges of the exponent forms", tool('"n"', '{"enum":[1e21,1e20,123456789012345678901,1e-6,1e-7,0.000001,0.0000001,1.5e-7,123456789e-20,4.35,0.1,0.2,0.30000000000000004,1e300,1.7976931348623157e308,5e-324,2.2250738585072014e-308]}'), "where ECMAScript changes from digits to an exponent"],
  ["integers beyond 2^53", tool('"n"', '{"enum":[9007199254740991,9007199254740992,9007199254740993,18446744073709551615,-9007199254740993,12345678901234567890]}'), "doubles that are not the integer written"],
  ["numbers that are not finite", tool('"n"', '{"enum":[1e999,-1e999,1e-999]}'), "JSON.stringify writes Infinity as null, and 1e-999 as 0"],
  ["booleans and null", tool('"b"', '{"default":null,"readOnly":true,"writeOnly":false,"nullable":null}'), "the three literals"],
  ["a schema as an API gives it", tool('"create_issue"', '{"type":"object","properties":{"title":{"type":"string","description":"Short title","maxLength":256},"labels":{"type":"array","items":{"type":"string"},"uniqueItems":true},"priority":{"type":"number","minimum":0.5,"maximum":9.5,"default":1.0},"assignee":{"type":["string","null"]}},"required":["title"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}', '{"type":"object","properties":{"id":{"type":"integer"},"url":{"type":"string","format":"uri"}},"required":["id"]}'), "an ordinary tool"],
];

// What the door must refuse, with why: `json` is a text JSON.parse refuses, `not_object` a JSON value that is no tool.
const refused = [
  ["empty text", "", "json"],
  ["only space", "  ", "json"],
  ["an object not closed", '{"name":"x"', "json"],
  ["a trailing comma in an object", '{"name":"x",}', "json"],
  ["a trailing comma in an array", '{"a":[1,]}', "json"],
  ["a member without a colon", '{"name" "x"}', "json"],
  ["a name that is not a string", "{name:1}", "json"],
  ["single quotes", "{'name':'x'}", "json"],
  ["text after the value", '{"name":"x"} {}', "json"],
  ["a number with a leading zero", '{"a":01}', "json"],
  ["a number with a plus sign", '{"a":+1}', "json"],
  ["a number with no digits after its point", '{"a":1.}', "json"],
  ["a number with no digit before its point", '{"a":.5}', "json"],
  ["an exponent with no digits", '{"a":1e}', "json"],
  ["NaN", '{"a":NaN}', "json"],
  ["Infinity", '{"a":Infinity}', "json"],
  ["a comment", '{"a":1 /* x */}', "json"],
  ["a string not closed", '{"a":"x}', "json"],
  ["a raw newline in a string", '{"a":"x\ny"}', "json"],
  ["a raw tab in a string", '{"a":"x\ty"}', "json"],
  ["an escape JSON does not have", '{"a":"\\x41"}', "json"],
  ["a \\u escape cut short", '{"a":"\\u12"}', "json"],
  ["a \\u escape that is not hexadecimal", '{"a":"\\u12G4"}', "json"],
  ["an array", "[]", "not_object"],
  ["an array of a tool", '[{"name":"x"}]', "not_object"],
  ["null", "null", "not_object"],
  ["a number", "1", "not_object"],
  ["a string", '"x"', "not_object"],
  ["true", "true", "not_object"],
];

const out = [];
const seen = new Map();
for (const [name, text, why] of vectors) {
  const parsed = JSON.parse(text);
  const digest = schemaDigest(parsed);
  const hashed = hashedText(parsed);
  if (digest !== sha256(hashed)) throw new Error(`${name}: the digest is not the SHA-256 of the canonical text`);
  seen.set(name, digest);
  out.push({ name, why, tool: text, canonical: hashed, digest });
}

// Two texts of one tool give one digest; two tools of one text give different ones only when they differ.
const same = (a, b) => {
  if (seen.get(a) !== seen.get(b)) throw new Error(`${a} and ${b} should be one digest`);
};
same("members in the order of a server", "the same tool in the order of the digest");
if (new Set(out.map((v) => v.digest)).size < out.length - 3) throw new Error("too many vectors share a digest: they test nothing apart");

const bad = [];
for (const [name, text, why] of refused) {
  let value;
  let threw = false;
  try {
    value = JSON.parse(text);
  } catch {
    threw = true;
  }
  const plain = !threw && value !== null && typeof value === "object" && !Array.isArray(value);
  if (why === "json" ? !threw : threw || plain) throw new Error(`${name}: JSON.parse does not agree it is ${why}`);
  bad.push({ name, tool: text, why });
}

const file = {
  format: "mandate/tool-schema-digest-vectors/0.1",
  source: "schemaDigest of runtime/src/mcp-client.ts, built to runtime/dist; written by scripts/tool-digest-vectors.mjs",
  vectors: out,
  refused: bad,
};
writeFileSync(new URL("vectors/tool-digest/tool-schema-digest.json", root), `${JSON.stringify(file, null, 1)}\n`);
console.log(`vectors/tool-digest/tool-schema-digest.json: ${out.length} tools, ${bad.length} refused texts`);
