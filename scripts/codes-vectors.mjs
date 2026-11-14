#!/usr/bin/env node
// Writes vectors/codes.json: the table of diagnostic codes of the TypeScript
// compiler (CODES in compiler/src/codes.ts, which `mandate explain` prints
// from), each row as its code, title and explanation, in the table's order,
// so that the table in the Rust compiler (crates/mandate-ir/src/codes.rs) is
// tested against the TypeScript for the codes up to language 0.5
// (crates/mandate-ir/tests/vectors.rs reads the file). The codes the Rust
// compiler adds from 0.6 on are in the Rust table alone and not in this file.
//
//   npm ci --ignore-scripts && npm run build    (once: it reads compiler/dist)
//   node scripts/codes-vectors.mjs
//
// The file is ASCII strict JSON (every character from U+007F up is written as
// a \u escape, as in the other files of vectors/). Running it again writes
// the same bytes.

import { writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const { CODES } = await import(new URL("compiler/dist/codes.js", root).href);

const codes = Object.entries(CODES).map(([code, { title, explain }]) => ({ code, title, explain }));
const text = JSON.stringify({ format: "mandate/vectors/codes/0.1", codes }, null, 2).replace(
  /[^\x00-\x7e]/g,
  (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
);
writeFileSync(new URL("vectors/codes.json", root), `${text}\n`);
process.stdout.write(`codes: ${codes.length} codes\n`);
