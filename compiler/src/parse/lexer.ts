// Lexer for the `.mdt` text projection (Doc 4 §4, Appendix A).
//
// Newlines are insignificant. Identifiers are ASCII; the only non-ASCII
// character allowed outside strings and comments is the subset operator `⊆`.
// String literals may interpolate `{expr}`; the lexer keeps each
// interpolation's source text and position so the parser can read it with a
// nested lexer. `prompt"""…"""` is a prompt template; `"""…"""` is a
// multi-line string. Literal text is kept exactly as written.

import { diag, DiagnosticError, type Span } from "../diag.js";

export type TokKind = "ident" | "int" | "dec" | "duration" | "version" | "string" | "prompt" | "punct" | "eof";

export type RawPart = { text: string } | { src: string; line: number; col: number };

export interface Token {
  kind: TokKind;
  /** Identifier name, punctuation text, or the number lexeme. */
  text: string;
  /** For int: the integer. For duration: milliseconds. */
  num?: number;
  /** For string and prompt tokens. */
  parts?: RawPart[];
  /** A line break separates this token from the previous one. */
  nl?: true;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

const PUNCT = [
  "=>", "->", "==", "!=", "<=", ">=", "..", "::",
  "{", "}", "(", ")", "[", "]", "<", ">", ",", ".", ":", ";", "=", "!", "?", "|", "@", "+", "-", "*", "/", "⊆",
];

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const MAGNITUDE: Record<string, number> = { k: 1000, M: 1_000_000 };

export function tokenSpan(t: Token): Span {
  return [t.line, t.col, t.endLine, t.endCol];
}

export class Lexer {
  private pos = 0;
  private line: number;
  private col: number;
  private prev: Token | undefined;

  constructor(
    private readonly src: string,
    startLine = 1,
    startCol = 1,
  ) {
    this.line = startLine;
    this.col = startCol;
  }

  tokenize(): Token[] {
    const out: Token[] = [];
    for (;;) {
      const t = this.next();
      out.push(t);
      this.prev = t;
      if (t.kind === "eof") return out;
    }
  }

  private fail(message: string, line = this.line, col = this.col): never {
    throw new DiagnosticError([diag("E0101", message, { span: [line, col, line, col + 1] })]);
  }

  private peek(o = 0): string {
    return this.src[this.pos + o] ?? "";
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

  /** Skips blanks and comments; true when a line break was crossed. */
  private skipTrivia(): boolean {
    let nl = false;
    for (;;) {
      const ch = this.peek();
      if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
        if (ch === "\n") nl = true;
        this.advance();
      } else if (ch === "/" && this.peek(1) === "/") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.advance();
      } else {
        return nl;
      }
    }
  }

  private make(kind: TokKind, text: string, line: number, col: number, extra: Partial<Token> = {}): Token {
    return { kind, text, line, col, endLine: this.line, endCol: this.col, ...extra };
  }

  private next(): Token {
    const nl = this.skipTrivia();
    const t = this.lex();
    if (nl) t.nl = true;
    return t;
  }

  private lex(): Token {
    const line = this.line;
    const col = this.col;
    if (this.pos >= this.src.length) return this.make("eof", "", line, col);
    const ch = this.peek();

    if (this.prev?.kind === "punct" && this.prev.text === "@" && isDigit(ch)) {
      let v = "";
      while (/[0-9A-Za-z.+-]/.test(this.peek())) v += this.advance();
      if (!/^[0-9]+(\.[0-9]+)*([-+][0-9A-Za-z.]+)?$/.test(v)) this.fail(`Malformed version '${v}'.`, line, col);
      return this.make("version", v, line, col);
    }

    if (isIdentStart(ch)) {
      let id = "";
      while (isIdentPart(this.peek())) id += this.advance();
      if (id === "prompt" && this.peek() === '"') {
        const parts = this.stringBody();
        return this.make("prompt", id, line, col, { parts });
      }
      return this.make("ident", id, line, col);
    }

    if (isDigit(ch)) return this.number(line, col);

    if (ch === '"') {
      const parts = this.stringBody();
      return this.make("string", "", line, col, { parts });
    }

    for (const p of PUNCT) {
      if (this.src.startsWith(p, this.pos)) {
        for (let i = 0; i < p.length; i++) this.advance();
        return this.make("punct", p, line, col);
      }
    }

    if (ch.charCodeAt(0) > 0x7f) {
      this.fail(`Non-ASCII character '${ch}' outside a string. Identifiers are ASCII.`, line, col);
    }
    return this.fail(`Unexpected character '${ch}'.`, line, col);
  }

  private number(line: number, col: number): Token {
    let digits = "";
    while (isDigit(this.peek()) || (this.peek() === "_" && isDigit(this.peek(1)))) {
      const c = this.advance();
      if (c !== "_") digits += c;
    }
    let frac = "";
    if (this.peek() === "." && isDigit(this.peek(1))) {
      this.advance();
      while (isDigit(this.peek())) frac += this.advance();
    }
    let suffix = "";
    while (/[A-Za-z]/.test(this.peek())) suffix += this.advance();
    const lexeme = frac ? `${digits}.${frac}` : digits;

    if (suffix === "") {
      if (frac) return this.make("dec", lexeme, line, col);
      return this.make("int", lexeme, line, col, { num: this.safeInt(lexeme, 1, line, col) });
    }
    if (suffix in DURATION_UNITS) {
      const ms = this.scaled(digits, frac, DURATION_UNITS[suffix]!, line, col, `${lexeme}${suffix}`);
      return this.make("duration", `${lexeme}${suffix}`, line, col, { num: ms });
    }
    if (suffix in MAGNITUDE) {
      const n = this.scaled(digits, frac, MAGNITUDE[suffix]!, line, col, `${lexeme}${suffix}`);
      return this.make("int", `${lexeme}${suffix}`, line, col, { num: n });
    }
    return this.fail(`Unknown number suffix '${suffix}'. Use k or M for counts and ms, s, m, h or d for durations.`, line, col);
  }

  private safeInt(lexeme: string, scale: number, line: number, col: number): number {
    const n = Number(lexeme) * scale;
    if (!Number.isSafeInteger(n)) this.fail(`Integer ${lexeme} is outside ±(2^53−1).`, line, col);
    return n;
  }

  /** Exact digits.frac × scale, which must come out whole. */
  private scaled(digits: string, frac: string, scale: number, line: number, col: number, lexeme: string): number {
    const n = scaleDecimal(digits, frac, scale);
    if (n === undefined) this.fail(`${lexeme} is not a whole number of base units.`, line, col);
    if (!Number.isSafeInteger(n)) this.fail(`${lexeme} is outside ±(2^53−1).`, line, col);
    return n;
  }

  private stringBody(): RawPart[] {
    const triple = this.src.startsWith('"""', this.pos);
    const startLine = this.line;
    const startCol = this.col;
    for (let i = 0; i < (triple ? 3 : 1); i++) this.advance();
    const parts: RawPart[] = [];
    let text = "";
    for (;;) {
      if (this.pos >= this.src.length) this.fail("Unterminated string.", startLine, startCol);
      const ch = this.peek();
      if (triple ? this.src.startsWith('"""', this.pos) : ch === '"') {
        for (let i = 0; i < (triple ? 3 : 1); i++) this.advance();
        break;
      }
      if (!triple && ch === "\n") this.fail("Newline in a single-line string; use \"\"\"…\"\"\".", startLine, startCol);
      if (ch === "\\") {
        this.advance();
        const esc = this.advance();
        const map: Record<string, string> = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\", "{": "{", "}": "}" };
        const v = map[esc];
        if (v === undefined) this.fail(`Invalid escape '\\${esc}'.`);
        text += v;
        continue;
      }
      if (ch === "{") {
        if (text) parts.push({ text });
        text = "";
        this.advance();
        const line = this.line;
        const col = this.col;
        let depth = 1;
        let src = "";
        for (;;) {
          if (this.pos >= this.src.length) this.fail("Unterminated interpolation.", line, col);
          const c = this.peek();
          if (c === '"') this.fail("String literals inside an interpolation are not supported.", this.line, this.col);
          if (c === "{") depth++;
          if (c === "}" && --depth === 0) {
            this.advance();
            break;
          }
          src += this.advance();
        }
        parts.push({ src, line, col });
        continue;
      }
      if (ch === "}") this.fail("Unmatched '}' in string; escape it as '\\}'.");
      text += this.advance();
    }
    if (text) parts.push({ text });
    return parts;
  }
}

/** digits.frac × scale as an exact integer, or undefined if not whole. */
export function scaleDecimal(digits: string, frac: string, scale: number): number | undefined {
  // scale is a power of ten times a small integer; work in BigInt to stay exact.
  const denom = 10n ** BigInt(frac.length);
  const num = BigInt(digits + frac) * BigInt(scale);
  if (num % denom !== 0n) return undefined;
  const v = num / denom;
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) return Number.POSITIVE_INFINITY;
  return Number(v);
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}
function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}
function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
