#!/usr/bin/env node
// Writes crates/mandate-ir/tests/data/js-semantics.json: what ECMAScript,
// as Node runs it, gives for the operations whose Rust counterpart differs,
// so that mandate-ir's helpers are tested against Node and not against
// expectations written by hand (crates/mandate-ir/tests/js.rs reads it).
//
//   node scripts/js-semantics.mjs
//
// The inputs are fixed edges and pseudo-random values from a fixed seed, so
// running it again writes the same file. The file is ASCII: every character
// from U+007F up is written as a \u escape.
//
// A JavaScript value that JSON cannot hold (undefined, -0, NaN, a number
// with a fraction) is given in a tagged form that the Rust test rebuilds:
//   null, true, false        themselves
//   ["u"]                    undefined
//   ["n", "<hex bits>"]      the double with these IEEE 754 bits
//   ["s", "text"]            a string
//   ["a", [tagged...]]       an array
//   ["o", [[key, tagged]...]] an object, its members assigned in this order
//                            (a name given twice is assigned twice)

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const view = new DataView(new ArrayBuffer(8));
const bitsOf = (x) => {
  view.setFloat64(0, x);
  return view.getBigUint64(0).toString(16).padStart(16, "0");
};
const fromBits = (b) => {
  view.setBigUint64(0, b);
  return view.getFloat64(0);
};

// xorshift64*, from a fixed seed.
let state = 0x2545f4914f6cdd1dn;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const below = (n) => Number(next() % BigInt(n));

/** The JavaScript value of a tagged one. */
function build(t) {
  if (t === null || typeof t === "boolean") return t;
  switch (t[0]) {
    case "u":
      return undefined;
    case "n":
      return fromBits(BigInt(`0x${t[1]}`));
    case "s":
      return t[1];
    case "a":
      return t[1].map(build);
    case "o": {
      const o = {};
      for (const [k, v] of t[1]) o[k] = build(v);
      return o;
    }
  }
  throw new Error(`bad tag ${JSON.stringify(t)}`);
}
const n = (x) => ["n", bitsOf(x)];
const s = (x) => ["s", x];
const a = (...xs) => ["a", xs];
const o = (...kvs) => ["o", kvs];
const U = ["u"];

// 1. Number::toString, Number.isInteger and Number.isSafeInteger.
const doubles = new Set();
[
  0, -0, 1, -1, 0.1, 0.2, 0.1 + 0.2, 0.5, -0.5, 1.5, 2.5, -2.5, 1 / 3, 100, 123.456, 1e20, 1e21, 1e-6, 1e-7, 1.5e-7, 5e-324, -5e-324,
  1.7976931348623157e308, 2.2250738585072014e-308, 2 ** 53 - 2, 2 ** 53 - 1, 2 ** 53, 2 ** 53 + 2, -(2 ** 53 - 1), -(2 ** 53), 2 ** 63, 2 ** 64,
  4294967294, 4294967295, 4294967296, 1e15 + 0.5, 4.35, 0.07, 1000000, 123e-20, 6.02214076e23, NaN, Infinity, -Infinity,
].forEach((x) => doubles.add(x));
for (let e = -324; e <= 308; e += 7) doubles.add(Number(`1e${e}`)).add(Number(`-2.5e${e}`));
for (let k = 0; k <= 64; k++) doubles.add(2 ** k).add(2 ** k - 1).add(2 ** k + 0.5);
for (let i = 0; i < 600; i++) doubles.add(fromBits(next()));
for (let i = 0; i < 400; i++) {
  const digits = 1 + below(17);
  const m = String(1 + below(9)) + Array.from({ length: digits - 1 }, () => String(below(10))).join("");
  doubles.add(Number(`${below(2) ? "-" : ""}${m}e${below(60) - 30}`));
}
// Ties (Number::toString, ECMA-262 §6.1.6.1.20 Note 2): x lies exactly
// halfway between the two numbers of its shortest length k that read back as
// x, and the one whose last digit is even is taken. Such an x has an exact
// decimal expansion of k + 1 significant digits ending in 5. A family (the
// doubles n + 0.25, which round down to even, and n + 0.75, which round up,
// just above 2^50, of either sign), and some hundreds found by a search with
// its own seed, so that the other vectors stay as they were.
function isTie(x) {
  if (!Number.isFinite(x) || x === 0) return false;
  const a = Math.abs(x);
  view.setFloat64(0, a);
  const raw = view.getBigUint64(0);
  const expBits = Number((raw >> 52n) & 0x7ffn);
  const frac = raw & 0xfffffffffffffn;
  const mant = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  // a = digits × 10^q exactly.
  let digits = e >= 0 ? (mant << BigInt(e)).toString() : (mant * 5n ** BigInt(-e)).toString();
  let q = Math.min(e, 0);
  while (digits.endsWith("0")) {
    digits = digits.slice(0, -1);
    q += 1;
  }
  const k = a.toExponential().split("e")[0].replace(".", "").length;
  if (digits.length !== k + 1 || !digits.endsWith("5")) return false;
  const lower = BigInt(digits.slice(0, k));
  const upper = lower + 1n;
  const tie = String(upper).length === k && Number(`${lower}e${q + 1}`) === a && Number(`${upper}e${q + 1}`) === a;
  if (tie && Number(a.toExponential().split("e")[0].slice(-1)) % 2 !== 0) throw new Error(`a tie not taken to even: ${a}`);
  return tie;
}
const ties = [];
{
  let seed = 0xbb67ae8584caa73bn;
  const rand = () => {
    seed ^= seed >> 12n;
    seed ^= (seed << 25n) & 0xffffffffffffffffn;
    seed ^= seed >> 27n;
    return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  };
  const tie = (x) => {
    if (isTie(x) && !ties.includes(x) && !doubles.has(x)) ties.push(x);
  };
  for (const bits of ["4313d27da8ac08c1", "c287fb5648a7cc40", "42e661f820d08374"]) tie(fromBits(BigInt(`0x${bits}`)));
  for (let i = 0; i < 64; i++) for (const f of [0.25, 0.75]) for (const sign of [1, -1]) tie(sign * (2 ** 50 + i * 104729 + f));
  for (let i = 0; i < 200000 && ties.length < 559; i++) {
    const m = Number((rand() >> 11n) | (1n << 52n));
    const x = m / 2 ** (1 + Number(rand() % 6n));
    tie(rand() & 1n ? -x : x);
  }
}
ties.forEach((x) => doubles.add(x));
// Every power of two: there the doubles on the two sides are not equally far
// apart, and the digits rounded half to even may not read back.
for (let e = -1074; e <= 1023; e++) doubles.add(2 ** e);
// A Set holds one zero; -0 is given by its bits.
const numbers = [[bitsOf(-0), String(-0), Number.isInteger(-0), Number.isSafeInteger(-0)]];
for (const x of doubles) numbers.push([bitsOf(x), String(x), Number.isInteger(x), Number.isSafeInteger(x)]);

// 2. The order of an ordinary object's own keys (OrdinaryOwnPropertyKeys):
// array indices (canonical integers up to 2^32 - 2) first, ascending, then the
// other names in the order they were first assigned.
const KEYS = [
  "b", "0", "10", "a", "007", "4294967294", "4294967295", "4294967296", "-1", "-0", "1", "00", "01", "9", "1.0", "1e3", " 1", "+1", "",
  "9007199254740991", "١", "１", "\u{1F600}", "2", "z", "10",
];
const orders = [];
const order = (keys) => {
  const obj = {};
  for (const k of keys) obj[k] = 0;
  orders.push([keys, Object.keys(obj), Object.keys(JSON.parse(JSON.stringify(obj)))]);
};
order(KEYS);
order([...KEYS].reverse());
for (let i = 0; i < 8; i++) {
  const keys = [...KEYS];
  for (let j = keys.length - 1; j > 0; j--) {
    const k = below(j + 1);
    [keys[j], keys[k]] = [keys[k], keys[j]];
  }
  order(keys);
}
// Assignments and deletes, long enough for objects of many members: each
// sequence is [["set", key] or ["delete", key], ...] and the object it
// leaves, written by JSON.stringify (a set assigns the number of the step).
const edits = [];
{
  let seed = 0x3c6ef372fe94f82bn;
  const rand = (n) => {
    seed ^= seed >> 12n;
    seed ^= (seed << 25n) & 0xffffffffffffffffn;
    seed ^= seed >> 27n;
    return Number(((seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn) % BigInt(n));
  };
  const pool = [...new Set([...KEYS, ...Array.from({ length: 40 }, (_, i) => (i % 3 === 0 ? String(i * 37) : `k${i}`))])];
  for (const steps of [20, 60, 200, 600]) {
    const ops = [];
    const obj = {};
    for (let i = 0; i < steps; i++) {
      const key = pool[rand(pool.length)];
      if (rand(10) < 3) {
        ops.push(["delete", key]);
        delete obj[key];
      } else {
        ops.push(["set", key]);
        obj[key] = i;
      }
    }
    edits.push([ops, JSON.stringify(obj)]);
  }
}

// 3. JSON.stringify(v), JSON.stringify(v, null, 2) and String(v).
const VALUES = [
  U, null, true, false, n(0), n(-0), n(NaN), n(Infinity), n(-Infinity), n(1e21), n(0.1), n(-1.5e-7), n(2 ** 53 + 2),
  s(""), s("plain"), s('"\\/\b\f\n\r\t\u0000\u001f\u007f\u0085  ﻿\u{1F600}é'),
  a(), o(), a(U), a(U, null, n(1)), o(["a", U]), o(["a", U], ["b", U]), o(["a", n(1)], ["b", U], ["c", s("x")]),
  a(a(), o(), a(a())), o(["x", a()], ["y", o()]),
  o(["b", n(1)], ["10", n(2)], ["a", a(n(1), a(n(2), null), U)], ["0", o(["z", true], ["1", false])], ["4294967295", null]),
  o(["k", n(1)], ["j", n(2)], ["k", n(3)]),
  o(["nested", o(["deeper", o(["deepest", a(o(["u", U]), o(["v", n(-0)]))])])]),
  a(n(1), a(n(2), a(n(3), null, U)), s("x")), a(null), a(U, U), a(s("a"), o(["b", n(1)])), a(true, false), o(["\u{1F600}", s(" ")]),
];
const stringify = VALUES.map((t) => {
  const v = build(t);
  const compact = JSON.stringify(v);
  const pretty = JSON.stringify(v, null, 2);
  return [t, compact ?? null, pretty ?? null, String(v)];
});

// 4. The white space of String.prototype.trim and of \s in a regular
// expression (WhiteSpace and LineTerminator), over every code point.
const whitespace = [];
for (let c = 0; c <= 0x10ffff; c++) {
  if (c >= 0xd800 && c <= 0xdfff) continue;
  const ch = String.fromCodePoint(c);
  const trims = ch.trim() === "";
  if (trims !== /\s/.test(ch) || trims !== /^\s$/u.test(ch)) throw new Error(`trim and \\s differ at U+${c.toString(16)}`);
  if (trims) whitespace.push(c);
}
const TEXTS = [
  "", " ", "a", " a ", "\t\n\v\f\r a b  ﻿", "\u0085a\u0085", "᠎a᠎", "​a​", "  a　 ",
  " x ", "\u{1F600} \u{1F600}", "a\u0000", "           ",
];
const trim = TEXTS.map((t) => [t, t.trim(), t.trimStart(), t.trimEnd(), t.length]);

// 5. Array.prototype.sort with no comparator on strings (UTF-16 code units),
// and [...new Set(xs)] (insertion order, first occurrence kept).
const LISTS = [
  ["b", "a", "B", "A", "", "aa", "a\u0000"],
  ["\u{1F600}", "￿", "", "퟿", "\u{10000}", "\u{10FFFF}", "z", "é", "é"],
  ["10", "9", "1", "010", "-1", "1e3"],
  ["x", "y", "x", "z", "y", "x"],
];
const sort = LISTS.map((xs) => [xs, [...xs].sort(), [...new Set(xs)]]);

const out = {
  format: "mandate-ir/js-semantics/0.1",
  generator: "scripts/js-semantics.mjs",
  numbers,
  orders,
  edits,
  stringify,
  whitespace: [whitespace],
  trim,
  sort,
};

// One vector a line, ASCII only.
const ascii = (text) => text.replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
const parts = Object.entries(out).map(([k, v]) =>
  Array.isArray(v) ? `${JSON.stringify(k)}: [\n${v.map((x) => ascii(JSON.stringify(x))).join(",\n")}\n]` : `${JSON.stringify(k)}: ${ascii(JSON.stringify(v))}`,
);
const file = fileURLToPath(new URL("../crates/mandate-ir/tests/data/js-semantics.json", import.meta.url));
writeFileSync(file, `{\n${parts.join(",\n")}\n}\n`);
process.stdout.write(
  `${numbers.length} numbers (${ties.length} of them ties), ${orders.length} key orders, ${edits.length} edit sequences, ${stringify.length} values, ${whitespace.length} white space code points, ` +
    `${trim.length} trims, ${sort.length} lists: ${file}\n`,
);
