// Strict JSON reader for canonical IR input (Doc 4 §3.4, §3.5).
//
// JSON.parse silently keeps the last of two duplicate keys and turns every
// number into a float. Both are silent changes to meaning, which the IR forbids:
//   - duplicate object keys are rejected before schema validation (S01),
//   - numbers must be integers within ±(2^53−1); fractions and exponents are
//     rejected rather than rounded (S11); decimals travel as strings,
//   - strings are kept exactly as written: no Unicode normalization, and lone
//     surrogates are rejected because JCS cannot encode them (S11),
//   - nesting depth and input size are bounded.
// Every value's source span is recorded against its JSON Pointer so later
// phases can point diagnostics at the input.

import { diag, ptrToken, type Diagnostic, type Span } from "../diag.js";
import { LIMITS } from "../limits.js";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface ParsedJson {
  value: Json;
  spans: Map<string, Span>;
}

class JsonFail extends Error {
  constructor(readonly d: Diagnostic) {
    super(d.message);
  }
}

export function parseStrictJson(text: string): { ok: true; value: ParsedJson } | { ok: false; diagnostics: Diagnostic[] } {
  if (Buffer.byteLength(text, "utf8") > LIMITS.sourceBytes) {
    return {
      ok: false,
      diagnostics: [
        diag("E0105", `Input exceeds the ${LIMITS.sourceBytes}-byte source limit.`, {}, {
          facts: { limit: LIMITS.sourceBytes, actual: Buffer.byteLength(text, "utf8") },
        }),
      ],
    };
  }
  const reader = new Reader(text);
  try {
    reader.ws();
    const value = reader.value("", 1);
    reader.ws();
    if (!reader.eof()) reader.fail("E0108", "Unexpected content after the top-level JSON value.");
    return { ok: true, value: { value, spans: reader.spans } };
  } catch (e) {
    if (e instanceof JsonFail) return { ok: false, diagnostics: [e.d] };
    throw e;
  }
}

class Reader {
  pos = 0;
  line = 1;
  col = 1;
  readonly spans = new Map<string, Span>();

  constructor(private readonly src: string) {}

  eof(): boolean {
    return this.pos >= this.src.length;
  }

  fail(code: string, message: string, path?: string, facts?: Record<string, unknown>): never {
    const at: { span: Span; path?: string } = { span: [this.line, this.col, this.line, this.col + 1] };
    if (path !== undefined) at.path = path;
    throw new JsonFail(diag(code, message, at, facts ? { facts } : {}));
  }

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private advance(): string {
    const ch = this.src[this.pos++] ?? "";
    if (ch === "\n") {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return ch;
  }

  ws(): void {
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") this.advance();
      else return;
    }
  }

  private expect(ch: string): void {
    if (this.peek() !== ch) this.fail("E0108", `Expected '${ch}' but found ${this.describe()}.`);
    this.advance();
  }

  private describe(): string {
    return this.eof() ? "end of input" : `'${this.peek()}'`;
  }

  value(path: string, depth: number): Json {
    if (depth > LIMITS.jsonDepth) {
      this.fail("E0105", `JSON nesting exceeds the depth limit of ${LIMITS.jsonDepth}.`, path, { limit: LIMITS.jsonDepth });
    }
    const start: [number, number] = [this.line, this.col];
    const v = this.valueInner(path, depth);
    this.spans.set(path, [start[0], start[1], this.line, this.col]);
    return v;
  }

  private valueInner(path: string, depth: number): Json {
    const ch = this.peek();
    if (ch === "{") return this.object(path, depth);
    if (ch === "[") return this.array(path, depth);
    if (ch === '"') return this.string(path);
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number(path);
    if (this.src.startsWith("true", this.pos)) return this.word("true", true);
    if (this.src.startsWith("false", this.pos)) return this.word("false", false);
    if (this.src.startsWith("null", this.pos)) return this.word("null", null);
    return this.fail("E0108", `Unexpected ${this.describe()} where a JSON value was expected.`, path);
  }

  private word<T extends Json>(w: string, v: T): T {
    for (let i = 0; i < w.length; i++) this.advance();
    return v;
  }

  private object(path: string, depth: number): { [key: string]: Json } {
    this.expect("{");
    // Null prototype so keys like "__proto__" are ordinary data.
    const out = Object.create(null) as { [key: string]: Json };
    const seen = new Set<string>();
    this.ws();
    if (this.peek() === "}") {
      this.advance();
      return out;
    }
    for (;;) {
      this.ws();
      if (this.peek() !== '"') this.fail("E0108", `Expected an object key but found ${this.describe()}.`, path);
      const keyLine = this.line;
      const keyCol = this.col;
      const key = this.string(path);
      if (seen.has(key)) {
        const at = { path: path + "/" + ptrToken(key), span: [keyLine, keyCol, this.line, this.col] as Span };
        throw new JsonFail(
          diag("E0102", `Duplicate object key "${key}". Duplicate keys are rejected before schema validation.`, at, {
            facts: { key },
          }),
        );
      }
      seen.add(key);
      this.ws();
      this.expect(":");
      this.ws();
      out[key] = this.value(path + "/" + ptrToken(key), depth + 1);
      this.ws();
      if (this.peek() === ",") {
        this.advance();
        continue;
      }
      this.expect("}");
      return out;
    }
  }

  private array(path: string, depth: number): Json[] {
    this.expect("[");
    const out: Json[] = [];
    this.ws();
    if (this.peek() === "]") {
      this.advance();
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(`${path}/${out.length}`, depth + 1));
      this.ws();
      if (this.peek() === ",") {
        this.advance();
        continue;
      }
      this.expect("]");
      return out;
    }
  }

  private string(path: string): string {
    this.expect('"');
    let out = "";
    for (;;) {
      if (this.eof()) this.fail("E0108", "Unterminated string.", path);
      const ch = this.advance();
      if (ch === '"') break;
      if (ch === "\\") {
        const esc = this.advance();
        switch (esc) {
          case '"':
          case "\\":
          case "/":
            out += esc;
            break;
          case "b":
            out += "\b";
            break;
          case "f":
            out += "\f";
            break;
          case "n":
            out += "\n";
            break;
          case "r":
            out += "\r";
            break;
          case "t":
            out += "\t";
            break;
          case "u": {
            const hex = this.src.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("E0108", "Invalid \\u escape.", path);
            for (let i = 0; i < 4; i++) this.advance();
            out += String.fromCharCode(parseInt(hex, 16));
            break;
          }
          default:
            this.fail("E0108", `Invalid escape '\\${esc}'.`, path);
        }
        continue;
      }
      if (ch < " ") this.fail("E0108", "Unescaped control character in string.", path);
      out += ch;
    }
    if (!isWellFormed(out)) {
      this.fail("E0107", "String contains a lone surrogate; it has no canonical (JCS) encoding.", path);
    }
    return out;
  }

  private number(path: string): number {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(this.src.slice(this.pos));
    if (!m) return this.fail("E0108", "Malformed number.", path);
    const lexeme = m[0];
    if (m[2] !== undefined || m[3] !== undefined) {
      this.fail(
        "E0106",
        `Number ${lexeme} is not an integer. IR numbers are integers; write decimals as strings and money as integer micro-units.`,
        path,
        { lexeme },
      );
    }
    const n = Number(lexeme);
    if (!Number.isSafeInteger(n)) {
      this.fail("E0106", `Integer ${lexeme} is outside ±(2^53−1).`, path, { lexeme });
    }
    if (Object.is(n, -0)) this.fail("E0106", "Negative zero is not allowed; write 0.", path, { lexeme });
    for (let i = 0; i < lexeme.length; i++) this.advance();
    return n;
  }
}

/** True when the string has no unpaired UTF-16 surrogate. */
export function isWellFormed(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

