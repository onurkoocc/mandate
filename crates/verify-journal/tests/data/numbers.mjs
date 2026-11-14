// Writes numbers.json next to this file: how ECMAScript writes doubles
// (`Number::toString`, which the runtime's canonical form uses) and how it
// reads decimals (`Number`, as `JSON.parse` does), for tests/numbers.rs. The
// values are fixed edges and pseudo-random ones from a fixed seed, so running
// it again writes the same file.
//
//   node crates/verify-journal/tests/data/numbers.mjs

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
let state = 0x9e3779b97f4a7c15n;
const next = () => {
  state ^= state >> 12n;
  state ^= (state << 25n) & 0xffffffffffffffffn;
  state ^= state >> 27n;
  return (state * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
};
const below = (n) => Number(next() % BigInt(n));

const values = new Set();
const add = (x) => {
  if (Number.isFinite(x)) values.add(x);
};
// Edges of the forms: integers to 21 digits, fractions to 0.000001, exponents.
[
  0, -0, 1, -1, 0.1, 0.2, 0.3, 0.1 + 0.2, 0.5, 1 / 3, 2 / 3, 100, 123.456, -123.456, 1e20, 1e21, 999999999999999900000, 123456789012345680000,
  1e22, 1e23, 1e-5, 1e-6, 1e-7, 1.5e-7, 9.999999999999999e-7, 0.000001, 0.0000012345, 123e-20, 5e-324, 1e-323, 2.225073858507201e-308,
  2.2250738585072014e-308, 1.7976931348623157e308, 9007199254740991, 9007199254740992, 9007199254740994, 2 ** 63, 2 ** 64, 1e300, -2.5e-8,
  4.35, 0.07, 1234567.0, 1e15, 1e16, 1e17, 12345678901234567890, 1.2345678901234567e-7, 299792458, 6.02214076e23, 1.602176634e-19,
].forEach(add);
for (let e = -330; e <= 310; e++) {
  add(Number(`1e${e}`));
  add(Number(`1.5e${e}`));
}
for (let e = -1074; e <= 1023; e += 3) add(2 ** e);
for (let i = 0; i < 2000; i++) add(fromBits(next()));
for (let i = 0; i < 1000; i++) {
  // Short decimals, which have few digits: an integer of 1 to 17 digits times a power of ten.
  const digits = 1 + below(17);
  const s = String(1 + below(9)) + Array.from({ length: digits - 1 }, () => String(below(10))).join("");
  add(Number(`${below(2) ? "-" : ""}${s}e${below(660) - 340}`));
}

// Ties (Number::toString, ECMA-262 §6.1.6.1.20 Note 2): x lies exactly
// halfway between the two numbers of its shortest length k that read back as
// x, and the one whose last digit is even is taken. Such an x has an exact
// decimal expansion of k + 1 significant digits ending in 5. A family (the
// doubles n + 0.25, which round down to even, and n + 0.75, which round up,
// just above 2^50, of either sign) and some hundreds found by a search with
// its own seed, so that the vectors above and below stay as they were.
function isTie(x) {
  if (!Number.isFinite(x) || x === 0) return false;
  const a = Math.abs(x);
  view.setFloat64(0, a);
  const raw = view.getBigUint64(0);
  const expBits = Number((raw >> 52n) & 0x7ffn);
  const frac = raw & 0xfffffffffffffn;
  const m = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  // a = digits × 10^q exactly.
  let digits = e >= 0 ? (m << BigInt(e)).toString() : (m * 5n ** BigInt(-e)).toString();
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
  let seed = 0x6a09e667f3bcc909n;
  const rand = () => {
    seed ^= seed >> 12n;
    seed ^= (seed << 25n) & 0xffffffffffffffffn;
    seed ^= seed >> 27n;
    return (seed * 0x2545f4914f6cdd1dn) & 0xffffffffffffffffn;
  };
  const tie = (x) => {
    if (isTie(x) && !ties.includes(x)) ties.push(x);
  };
  for (const bits of ["4313d27da8ac08c1", "c287fb5648a7cc40", "42e661f820d08374"]) tie(fromBits(BigInt(`0x${bits}`)));
  for (let i = 0; i < 64; i++) for (const f of [0.25, 0.75]) for (const sign of [1, -1]) tie(sign * (2 ** 50 + i * 7919 + f));
  for (let i = 0; i < 200000 && ties.length < 559; i++) {
    const m = Number((rand() >> 11n) | (1n << 52n));
    const x = m / 2 ** (1 + Number(rand() % 6n));
    tie(rand() & 1n ? -x : x);
  }
}
ties.forEach(add);

// A Set holds one zero; -0 is written as 0 too.
const write = [["8000000000000000", "0"], ...[...values].map((x) => [bitsOf(x), String(x)])];

/** The exact decimal of m × 2^e, for BigInt m >= 0. */
function exact(m, e) {
  if (e >= 0) return (m << BigInt(e)).toString();
  const k = -e;
  const digits = (m * 5n ** BigInt(k)).toString().padStart(k + 1, "0");
  return `${digits.slice(0, digits.length - k)}.${digits.slice(digits.length - k)}`.replace(/\.?0+$/, "");
}

const reads = new Map();
const lexeme = (s) => {
  const x = Number(s);
  reads.set(s, Number.isFinite(x) ? bitsOf(x) : null);
};
[
  "0", "-0", "0.0", "-0.0", "1", "1.0", "1e0", "10e-1", "1E21", "0.10", "1.0e0", "1e-400", "-1e-400", "1e400", "-1e400", "1.8e308",
  "9007199254740993", "9007199254740995", "2.2250738585072011e-308", "2.2250738585072012e-308", "4.9406564584124654e-324",
  "2.4703282292062327e-324", "2.4703282292062328e-324", "1.7976931348623157e308", "1.7976931348623158e308", "1.7976931348623159e308",
  "0.1", "0.30000000000000004", "123456789012345678901234567890", `1${"0".repeat(308)}`, `1${"0".repeat(309)}`, `0.${"0".repeat(400)}1`,
  "1e-99999999999", "1e99999999999", "-0e5", "0e-5",
].forEach(lexeme);
// The midpoint between a double and the next: a tie, which goes to the even one; and just above and below it.
for (let i = 0; i < 60; i++) {
  let b = next() & 0x7fefffffffffffffn;
  const x = fromBits(b);
  view.setFloat64(0, x);
  const raw = view.getBigUint64(0);
  const expBits = Number((raw >> 52n) & 0x7ffn);
  const frac = raw & 0xfffffffffffffn;
  const m = expBits === 0 ? frac : frac | (1n << 52n);
  const e = (expBits === 0 ? 1 : expBits) - 1075;
  const mid = exact(2n * m + 1n, e - 1);
  lexeme(mid);
  lexeme(mid.includes(".") ? `${mid}000000000000000000001` : `${mid}.000000000000000000001`);
  if (mid.includes(".")) lexeme(`${mid.slice(0, -1)}${String(Number(mid.slice(-1)) - 1)}999999999999`);
}
for (let i = 0; i < 400; i++) {
  const digits = 17 + below(30);
  const s = String(1 + below(9)) + Array.from({ length: digits - 1 }, () => String(below(10))).join("");
  lexeme(`${s.slice(0, 1)}.${s.slice(1)}e${below(640) - 330}`);
}

const out = {
  format: "verify-journal/number-vectors/0.1",
  generator: "crates/verify-journal/tests/data/numbers.mjs",
  write: write,
  read: [...reads].map(([s, bits]) => [s, bits]),
};
const file = join(dirname(fileURLToPath(import.meta.url)), "numbers.json");
writeFileSync(file, JSON.stringify(out, null, 0).replaceAll("],[", "],\n[") + "\n");
process.stdout.write(`${write.length} doubles written (${ties.length} of them ties), ${reads.size} decimals read: ${file}\n`);
