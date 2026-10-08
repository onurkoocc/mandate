// Parser for the `.mdt` text projection. It lowers straight into canonical IR
// (ir/types.ts) and records a source span for every IR node it builds, so
// diagnostics on the IR can point back at the text.
//
// Grammar: Doc 4 Appendix A, widened to cover every example in Doc 4
// (unions with payloads, `switch`, top-level `let`, `on … in … =>` handlers,
// `test` blocks, remote agents). Statements need no separator; a statement
// ends where the next one begins. Line breaks matter in three places only: a
// call's `(`, a postfix `?` and a record literal's `{` must stay on the line
// of what they apply to, and `return` takes a value only from its own line.
//
// Reserved keywords are kept under the C1 limit of 40. Words such as `role`,
// `caps`, `budget`, `critical`, `isolated` or `test` are contextual: they act
// as keywords only in the position that expects them (`test` stays usable as
// the std.test module name).

import { diag, DiagnosticError, type Diagnostic, type Span } from "../diag.js";
import { canonicalize } from "../json/jcs.js";
import type { Json } from "../json/strict-json.js";
import {
  LANGUAGE_VERSION,
  type Arg,
  type BinaryOp,
  type Budget,
  type CallSpec,
  type ContractDef,
  type Criterion,
  type Def,
  type EffectDef,
  type EffectRef,
  type Expr,
  type OnHandler,
  type Param,
  type Pattern,
  type Program,
  type Skill,
  type Stmt,
  type TemplatePart,
  type TestDef,
  type TypeExpr,
  type Use,
  type Variant,
  type Verifier,
} from "../ir/types.js";
import { Lexer, tokenSpan, type RawPart, type Token } from "./lexer.js";

export const RESERVED = new Set([
  "module", "use", "type", "enum", "capability", "fn", "pub", "extern", "effect", "agent", "skill",
  "workflow", "contract", "let", "par", "delegate", "spawn", "await", "verify", "infer",
  "if", "else", "loop", "return", "switch", "on", "with", "in", "where", "and", "or", "not",
  "true", "false",
]);

const CURRENCY = /^[A-Z]{3}$/;

export interface ParseResult {
  program?: Program;
  /** IR node → source span; turned into JSON-Pointer spans by sourceMap(). */
  spans: WeakMap<object, Span>;
  diagnostics: Diagnostic[];
}

export function parseMdt(src: string): ParseResult {
  const spans = new WeakMap<object, Span>();
  try {
    const toks = new Lexer(src).tokenize();
    const p = new Parser(toks, spans);
    const program = p.program();
    return { program, spans, diagnostics: p.diagnostics };
  } catch (e) {
    if (e instanceof DiagnosticError) return { spans, diagnostics: e.diagnostics };
    throw e;
  }
}

interface ExprCtx {
  /** Disallow `Name { … }` record literals (conditions of if/loop/switch). */
  noStruct?: boolean;
}

class Parser {
  private i = 0;
  readonly diagnostics: Diagnostic[] = [];
  private inTest = false;

  constructor(
    private readonly toks: Token[],
    private readonly spans: WeakMap<object, Span>,
  ) {}

  // ── token helpers ──────────────────────────────────────────────────────

  private get t(): Token {
    return this.toks[this.i]!;
  }
  private atEof(): boolean {
    return this.t.kind === "eof";
  }
  private la(n: number): Token {
    return this.toks[Math.min(this.i + n, this.toks.length - 1)]!;
  }
  private bump(): Token {
    const t = this.t;
    if (t.kind !== "eof") this.i++;
    return t;
  }
  private isP(text: string, t: Token = this.t): boolean {
    return t.kind === "punct" && t.text === text;
  }
  private isW(word: string, t: Token = this.t): boolean {
    return t.kind === "ident" && t.text === word;
  }
  private eatP(text: string): boolean {
    if (this.isP(text)) {
      this.bump();
      return true;
    }
    return false;
  }
  private eatW(word: string): boolean {
    if (this.isW(word)) {
      this.bump();
      return true;
    }
    return false;
  }
  private fail(message: string, t: Token = this.t): never {
    throw new DiagnosticError([diag("E0101", message, { span: tokenSpan(t) })]);
  }
  private describe(t: Token = this.t): string {
    if (t.kind === "eof") return "end of input";
    if (t.kind === "string" || t.kind === "prompt") return "a string";
    return `'${t.text}'`;
  }
  private expectP(text: string): Token {
    if (!this.isP(text)) this.fail(`Expected '${text}' but found ${this.describe()}.`);
    return this.bump();
  }
  private expectW(word: string): Token {
    if (!this.isW(word)) this.fail(`Expected '${word}' but found ${this.describe()}.`);
    return this.bump();
  }
  private ident(what = "a name"): string {
    const t = this.t;
    if (t.kind !== "ident") this.fail(`Expected ${what} but found ${this.describe()}.`);
    if (RESERVED.has(t.text)) this.fail(`'${t.text}' is a reserved keyword and cannot be used as ${what}.`);
    this.bump();
    return t.text;
  }
  private qname(): string {
    let name = this.ident();
    while (this.isP(".") && this.la(1).kind === "ident") {
      this.bump();
      name += "." + this.ident();
    }
    return name;
  }
  private string(what = "a string"): string {
    const t = this.t;
    if (t.kind !== "string") this.fail(`Expected ${what} but found ${this.describe()}.`);
    this.bump();
    const parts = t.parts ?? [];
    if (parts.some((p) => "src" in p)) this.fail(`Interpolation is not allowed in ${what}.`, t);
    return parts.map((p) => ("text" in p ? p.text : "")).join("");
  }
  /** Records the span from `start` to the previous token on an IR node. */
  private at<T extends object>(node: T, start: Token): T {
    const end = this.toks[Math.max(this.i - 1, 0)]!;
    this.spans.set(node, [start.line, start.col, end.endLine, end.endCol]);
    return node;
  }
  private dup(kind: string, name: string, t: Token): void {
    this.diagnostics.push(diag("E0121", `Duplicate ${kind} '${name}'.`, { span: tokenSpan(t) }, { facts: { name } }));
  }

  // ── program ────────────────────────────────────────────────────────────

  program(): Program {
    const start = this.t;
    this.expectW("module");
    const module = this.qname();
    this.expectP("@");
    if (this.t.kind !== "version") this.fail(`Expected a module version after '@' but found ${this.describe()}.`);
    const version = this.bump().text;

    const uses: Use[] = [];
    while (this.isW("use")) uses.push(this.use());

    const defs: Record<string, Def> = Object.create(null);
    const tests: Record<string, TestDef> = Object.create(null);
    const handlers: Array<{ target: string; handler: OnHandler; tok: Token }> = [];

    while (!this.atEof()) {
      const t = this.t;
      if (this.isW("on")) {
        handlers.push(this.topLevelOn());
        continue;
      }
      if (this.isW("test") && this.la(1).kind === "string") {
        this.bump();
        const nameTok = this.t;
        const name = this.string("a test name");
        const test = this.at(this.testBody(), t);
        if (name in tests) this.dup("test", name, nameTok);
        tests[name] = test;
        continue;
      }
      const [name, def, nameTok] = this.decl();
      if (name in defs) this.dup("definition", name, nameTok);
      defs[name] = this.at(def, t);
    }

    for (const { target, handler, tok } of handlers) {
      const wf = defs[target];
      if (!wf || wf.kind !== "workflow") {
        this.diagnostics.push(
          diag("E0120", `Handler targets '${target}', which is not a workflow in this module.`, { span: tokenSpan(tok) }, {
            facts: { name: target },
          }),
        );
        continue;
      }
      (wf.on ??= []).push(handler);
    }

    const program: Program = { language: LANGUAGE_VERSION, module, version, defs };
    if (uses.length) program.uses = sortCanon(uses);
    if (Object.keys(tests).length) program.tests = tests;
    return this.at(program, start);
  }

  private use(): Use {
    const start = this.bump();
    const module = this.qname();
    const u: Use = { module };
    if (this.isP(".") && this.isP("{", this.la(1))) {
      this.bump();
      this.bump();
      const names: string[] = [];
      while (!this.isP("}")) {
        names.push(this.ident("an imported name"));
        if (!this.eatP(",")) break;
      }
      this.expectP("}");
      u.names = [...new Set(names)].sort();
    }
    return this.at(u, start);
  }

  private topLevelOn(): { target: string; handler: OnHandler; tok: Token } {
    const start = this.bump();
    const event = this.ident("an event name");
    this.expectW("in");
    const tok = this.t;
    const target = this.ident("a workflow name");
    this.expectP("=>");
    const then = this.expr();
    return { target, handler: this.at({ event, then }, start), tok };
  }

  private decl(): [string, Def, Token] {
    const t = this.t;
    if (t.kind !== "ident") this.fail(`Expected a declaration but found ${this.describe()}.`);
    switch (t.text) {
      case "type":
        return this.typeDecl();
      case "capability": {
        this.bump();
        const nameTok = this.t;
        const name = this.ident("a capability name");
        this.expectP("=");
        return [name, { kind: "capability", value: this.expr() }, nameTok];
      }
      case "let": {
        this.bump();
        const nameTok = this.t;
        const name = this.ident();
        const def: Def = { kind: "const", value: { op: "int", value: 0 } };
        if (this.eatP(":")) def.type = this.typeExpr();
        this.expectP("=");
        def.value = this.expr();
        return [name, def, nameTok];
      }
      case "pub":
      case "fn":
        return this.fnDecl();
      case "extern":
        return this.externDecl();
      case "effect":
        return this.effectDecl();
      case "agent":
        return this.agentDecl();
      case "workflow":
        return this.workflowDecl();
      case "contract":
        return this.contractDecl();
    }
    return this.fail(`Expected a declaration but found ${this.describe()}.`);
  }

  // ── declarations ───────────────────────────────────────────────────────

  private typeDecl(): [string, Def, Token] {
    this.bump();
    const nameTok = this.t;
    const name = this.ident("a type name");
    let generics: string[] | undefined;
    if (this.eatP("<")) {
      generics = [];
      do generics.push(this.ident("a type parameter"));
      while (this.eatP(","));
      this.expectP(">");
    }
    this.expectP("=");
    let type: TypeExpr;
    const startsUnion =
      this.t.kind === "ident" && !RESERVED.has(this.t.text) && (this.isP("(", this.la(1)) || this.isP("|", this.la(1)));
    if (startsUnion) {
      const start = this.t;
      const variants: Variant[] = [];
      const seen = new Set<string>();
      do {
        const vt = this.t;
        const tag = this.ident("a variant name");
        const v: Variant = { tag };
        if (this.isP("(")) v.fields = this.params();
        if (seen.has(tag)) this.dup("variant", tag, vt);
        seen.add(tag);
        variants.push(this.at(v, vt));
      } while (this.eatP("|"));
      type = this.at({ union: variants }, start);
    } else {
      type = this.typeExpr({ allowWhere: true });
    }
    const def: Def = { kind: "type", type };
    if (generics) def.generics = generics;
    return [name, def, nameTok];
  }

  private fnDecl(): [string, Def, Token] {
    const pub = this.eatW("pub");
    this.expectW("fn");
    const nameTok = this.t;
    const name = this.ident("a function name");
    const params = this.params();
    this.expectP("->");
    const returns = this.typeExpr();
    const def: Def = { kind: "fn", params, returns, body: [] };
    if (pub) def.pub = true;
    if (this.isP("!")) def.effects = this.effects();
    if (this.isW("budget")) def.budget = this.budget();
    def.body = this.block();
    return [name, def, nameTok];
  }

  private externDecl(): [string, Def, Token] {
    this.bump();
    const langTok = this.t;
    const lang = this.ident("a host language");
    if (lang !== "py" && lang !== "ts" && lang !== "java") this.fail(`Unknown host language '${lang}'; expected py, ts or java.`, langTok);
    const file = this.string("a host file path");
    this.expectP("::");
    const nameTok = this.t;
    const symbol = this.ident("a host symbol");
    const params = this.params();
    this.expectP("->");
    const returns = this.typeExpr();
    const effects = this.effects();
    const def: Def = { kind: "extern", lang, file, symbol, params, returns, effects };
    if (this.eatW("idempotent_by")) def.idempotent_by = this.expr();
    return [symbol, def, nameTok];
  }

  private effectDecl(): [string, Def, Token] {
    this.bump();
    const nameTok = this.t;
    const name = this.qname();
    const params = this.params();
    this.expectP("->");
    const returns = this.typeExpr();
    const def: EffectDef = { kind: "effect", params, returns };
    for (;;) {
      if (this.eatW("requires")) {
        this.expectW("caps");
        (def.requires_caps ??= []).push(this.expr());
      } else if (this.eatW("critical")) def.critical = true;
      else if (this.eatW("irreversible")) def.irreversible = true;
      else if (this.eatW("idempotency")) {
        this.expectW("required");
        def.idempotency_required = true;
      } else if (this.eatW("compensation")) def.compensation = this.qname();
      else if (this.eatW("retry_class")) {
        const t = this.t;
        const rc = this.ident("a retry class");
        if (rc !== "read_only" && rc !== "idempotent" && rc !== "reconcilable" && rc !== "non_retryable") {
          this.fail(`Unknown retry class '${rc}'.`, t);
        }
        def.retry_class = rc;
      } else break;
    }
    if (def.requires_caps) def.requires_caps = sortCanon(def.requires_caps);
    return [name, def, nameTok];
  }

  private agentDecl(): [string, Def, Token] {
    this.bump();
    const remote = this.eatW("remote");
    const nameTok = this.t;
    const name = this.ident("an agent name");
    const def: Def = { kind: "agent", caps: [], skills: Object.create(null) };
    if (remote) {
      this.expectP("=");
      const bindStart = this.t;
      def.remote = this.at({ bind: this.expr() }, bindStart);
      for (;;) {
        if (this.eatW("version")) def.remote.version = this.string("a version string");
        else if (this.eatW("require")) (def.remote.require ??= []).push(this.expr());
        else if (this.eatW("trust")) {
          const t = this.t;
          const trust = this.ident("a trust level");
          if (trust !== "trusted" && trust !== "untrusted") this.fail(`Unknown trust level '${trust}'.`, t);
          def.remote.trust = trust;
        } else if (this.eatW("caps")) def.caps.push(...this.exprList());
        else if (this.eatW("skills")) {
          this.expectP("{");
          while (!this.isP("}")) this.skill(def.skills, { remote: true });
          this.expectP("}");
        } else break;
      }
    } else {
      this.expectP("{");
      while (!this.isP("}")) {
        const t = this.t;
        if (this.eatW("role")) def.role = this.string("a role description");
        else if (this.eatW("model")) def.model = this.ident("a model tier");
        else if (this.eatW("caps")) def.caps.push(...this.exprList());
        else if (this.isW("budget")) def.budget = this.budget();
        else if (this.eatW("skill")) this.skill(def.skills, { remote: false });
        else this.fail(`Expected role, model, caps, budget or skill in agent body but found ${this.describe(t)}.`);
      }
      this.expectP("}");
    }
    def.caps = sortCanon(def.caps);
    return [name, def, nameTok];
  }

  private skill(into: Record<string, Skill>, opts: { remote: boolean }): void {
    const start = this.t;
    const name = this.ident("a skill name");
    const params = this.params();
    this.expectP("->");
    const returns = this.typeExpr();
    const s: Skill = { params, returns, effects: [] };
    if (this.isP("!")) s.effects = this.effects();
    else if (!opts.remote) this.fail(`Skill '${name}' must declare its effects with '! { … }'.`);
    if (this.isW("budget")) s.budget = this.budget();
    if (!opts.remote && this.isP("{")) s.body = this.block();
    if (name in into) this.dup("skill", name, start);
    into[name] = this.at(s, start);
  }

  private workflowDecl(): [string, Def, Token] {
    this.bump();
    const nameTok = this.t;
    const name = this.ident("a workflow name");
    const params = this.params();
    this.expectP("->");
    const returns = this.typeExpr();
    this.expectW("caps");
    const caps = sortCanon(this.exprList());
    const def: Def = { kind: "workflow", params, returns, caps, body: [] };
    if (this.isW("budget")) def.budget = this.budget();
    if (this.eatW("ensures")) def.ensures = this.expr({ noStruct: true });
    def.body = this.block();
    return [name, def, nameTok];
  }

  private contractDecl(): [string, Def, Token] {
    this.bump();
    const nameTok = this.t;
    const name = this.ident("a contract name");
    const params = this.params();
    const def: ContractDef = { kind: "contract", params, accept: Object.create(null) };
    this.expectP("{");
    while (!this.isP("}")) {
      const t = this.t;
      if (this.eatW("require")) {
        (def.require ??= []).push(this.expr());
      } else if (this.isW("accept") || this.isW("invariant")) {
        const kind = this.bump().text as "accept" | "invariant";
        const ct = this.t;
        const cname = this.ident("a criterion name");
        const description = this.string("a criterion description");
        this.expectW("by");
        const crit: Criterion = this.at({ description, by: this.verifier() }, t);
        const into = kind === "accept" ? def.accept : (def.invariant ??= Object.create(null) as Record<string, Criterion>);
        if (cname in def.accept || (def.invariant && cname in def.invariant)) this.dup("criterion", cname, ct);
        into[cname] = crit;
      } else {
        this.fail(`Expected require, accept or invariant in contract body but found ${this.describe(t)}.`);
      }
    }
    this.expectP("}");
    return [name, def, nameTok];
  }

  private verifier(): Verifier {
    const parts: Verifier[] = [];
    do {
      const start = this.t;
      // A verifier operand binds tighter than `and`, which joins verifiers.
      if (this.eatW("static")) parts.push(this.at({ static: this.binary(PREC_AND + 1, {}) }, start));
      else parts.push(this.at({ call: this.binary(PREC_AND + 1, {}) }, start));
    } while (this.eatW("and"));
    return parts.length === 1 ? parts[0]! : { all: parts };
  }

  private testBody(): TestDef {
    this.expectP("{");
    const test: TestDef = { body: [] };
    if (this.isW("with") && this.isW("handlers", this.la(1))) {
      this.bump();
      this.bump();
      this.expectP("{");
      const handlers: Record<string, Expr> = Object.create(null);
      while (!this.isP("}")) {
        const t = this.t;
        const name = this.ident("an effect name");
        this.expectP("=");
        if (name in handlers) this.dup("handler", name, t);
        handlers[name] = this.expr();
        if (!this.eatP(",")) break;
      }
      this.expectP("}");
      test.handlers = handlers;
    }
    this.inTest = true;
    try {
      while (!this.isP("}")) test.body.push(this.stmt());
    } finally {
      this.inTest = false;
    }
    this.expectP("}");
    return test;
  }

  // ── shared pieces ──────────────────────────────────────────────────────

  private params(): Param[] {
    this.expectP("(");
    const out: Param[] = [];
    const seen = new Set<string>();
    while (!this.isP(")")) {
      const t = this.t;
      const name = this.ident("a parameter name");
      this.expectP(":");
      const type = this.typeExpr({ allowWhere: true });
      if (seen.has(name)) this.dup("parameter", name, t);
      seen.add(name);
      out.push(this.at({ name, type }, t));
      if (!this.eatP(",")) break;
    }
    this.expectP(")");
    return out;
  }

  private effects(): EffectRef[] {
    this.expectP("!");
    this.expectP("{");
    const out: EffectRef[] = [];
    while (!this.isP("}")) {
      const t = this.t;
      const e: EffectRef = { effect: this.qname() };
      if (this.isP("(")) e.args = this.args();
      out.push(this.at(e, t));
      if (!this.eatP(",")) break;
    }
    this.expectP("}");
    return sortCanon(out);
  }

  private budget(): Budget {
    const start = this.expectW("budget");
    this.expectP("{");
    const b: Budget = {};
    while (!this.isP("}")) {
      const kt = this.t;
      const key = this.ident("a budget field");
      this.expectP(":");
      const vt = this.t;
      const v = this.primary({});
      const bad = (want: string): never =>
        this.fail(`Budget field '${key}' takes ${want}.`, vt);
      if (key in b) this.dup("budget field", key, kt);
      switch (key) {
        case "tokens":
        case "steps":
          if (v.op !== "int") bad("an integer");
          b[key] = (v as { value: number }).value;
          break;
        case "spend":
          if (v.op !== "money") bad("an amount with a currency, e.g. 20 USD");
          b.spend = { micros: (v as { micros: number }).micros, currency: (v as { currency: string }).currency };
          break;
        case "time":
          if (v.op !== "duration") bad("a duration, e.g. 15m");
          b.time = { ms: (v as { ms: number }).ms };
          break;
        default:
          this.fail(`Unknown budget field '${key}'; expected tokens, spend, time or steps.`, kt);
      }
      if (!this.eatP(",")) break;
    }
    this.expectP("}");
    return this.at(b, start);
  }

  private typeExpr(opts: { allowWhere?: boolean } = {}): TypeExpr {
    const start = this.t;
    let ty: TypeExpr;
    if (this.eatW("enum")) {
      this.expectP("{");
      const members: string[] = [];
      while (!this.isP("}")) {
        const t = this.t;
        const m = this.ident("an enum member");
        if (members.includes(m)) this.dup("enum member", m, t);
        members.push(m);
        if (!this.eatP(",")) break;
      }
      this.expectP("}");
      ty = { enum: members };
    } else if (this.eatP("{")) {
      const record: Record<string, TypeExpr> = Object.create(null);
      while (!this.isP("}")) {
        const t = this.t;
        const name = this.ident("a field name");
        this.expectP(":");
        if (name in record) this.dup("field", name, t);
        record[name] = this.typeExpr({ allowWhere: true });
        if (!this.eatP(",")) break;
      }
      this.expectP("}");
      ty = { record };
    } else {
      const ref = this.qname();
      ty = { ref };
      if (this.eatP("<")) {
        const args: TypeExpr[] = [];
        do args.push(this.typeExpr());
        while (this.eatP(","));
        this.expectP(">");
        ty.args = args;
      }
    }
    this.at(ty, start);
    if (opts.allowWhere && this.eatW("where")) {
      ty = this.at({ refine: ty, where: this.expr() }, start);
    }
    return ty;
  }

  /** Comma-separated expressions. Never takes `Name { … }`, so a following block stays a block. */
  private exprList(): Expr[] {
    const out = [this.expr({ noStruct: true })];
    while (this.eatP(",")) out.push(this.expr({ noStruct: true }));
    return out;
  }

  private args(): Arg[] {
    this.expectP("(");
    const out: Arg[] = [];
    while (!this.isP(")")) {
      const t = this.t;
      if (t.kind === "ident" && this.isP(":", this.la(1)) && !RESERVED.has(t.text)) {
        this.bump();
        this.bump();
        out.push(this.at({ name: t.text, value: this.expr() }, t));
      } else {
        out.push(this.at({ value: this.expr() }, t));
      }
      if (!this.eatP(",")) break;
    }
    this.expectP(")");
    return out;
  }

  private callSpec(): CallSpec {
    const start = this.t;
    const c: CallSpec = { name: this.ident("a strategy name") };
    if (this.isP("(")) c.args = this.args();
    return this.at(c, start);
  }

  private block(): Stmt[] {
    this.expectP("{");
    const out: Stmt[] = [];
    while (!this.isP("}")) {
      if (this.t.kind === "eof") this.fail("Unterminated block; expected '}'.");
      out.push(this.stmt());
    }
    this.expectP("}");
    return out;
  }

  // ── statements ─────────────────────────────────────────────────────────

  private stmt(): Stmt {
    const start = this.t;
    if (this.eatW("let")) {
      const name = this.ident();
      const s: Stmt = { op: "let", name, value: { op: "int", value: 0 } };
      if (this.eatP(":")) s.type = this.typeExpr();
      this.expectP("=");
      s.value = this.expr();
      return this.at(s, start);
    }
    if (this.eatW("par")) {
      const s: Stmt = { op: "par", branches: Object.create(null) };
      if (this.eatW("supervise")) s.supervise = this.callSpec();
      this.expectP("{");
      while (!this.isP("}")) {
        const t = this.t;
        const name = this.ident("a branch name");
        this.expectP("=");
        if (name in s.branches) this.dup("par branch", name, t);
        s.branches[name] = this.expr();
      }
      this.expectP("}");
      return this.at(s, start);
    }
    if (this.eatW("if")) return this.at(this.ifRest(), start);
    if (this.eatW("loop")) {
      const s: Stmt = { op: "loop", body: [] };
      if (this.eatW("max_iter")) {
        const t = this.t;
        if (t.kind !== "int") this.fail("max_iter takes an integer.");
        s.max_iter = this.bump().num!;
      } else if (this.eatW("until")) {
        s.until = this.expr({ noStruct: true });
      }
      s.body = this.block();
      return this.at(s, start);
    }
    if (this.eatW("return")) {
      const s: Stmt = { op: "return" };
      // The value, if any, starts on the same line as `return`.
      if (!this.isP("}") && !this.t.nl) s.value = this.expr();
      return this.at(s, start);
    }
    if (this.isW("on") && this.isW("error", this.la(1))) {
      this.bump();
      this.bump();
      this.expectP("(");
      const pattern = this.pattern();
      this.expectP(")");
      this.expectP("=>");
      return this.at({ op: "on_error", pattern, then: this.expr() }, start);
    }
    if (this.inTest && this.isW("run")) {
      this.bump();
      const target = this.expr();
      this.expectW("expect");
      return this.at({ op: "run", target, expect: this.ident("an expected outcome") }, start);
    }
    return this.at({ op: "expr", value: this.expr() }, start);
  }

  private ifRest(): Stmt {
    const cond = this.expr({ noStruct: true });
    const s: Stmt = { op: "if", cond, then: this.block() };
    if (this.eatW("else")) {
      const t = this.t;
      if (this.eatW("if")) s.else = [this.at(this.ifRest(), t)];
      else s.else = this.block();
    }
    return s;
  }

  private pattern(): Pattern {
    const start = this.t;
    if (this.isW("_")) {
      this.bump();
      return this.at({ p: "wild" }, start);
    }
    const name = this.ident("a pattern");
    if (this.isP("(")) {
      this.bump();
      const args: Pattern[] = [];
      while (!this.isP(")")) {
        args.push(this.pattern());
        if (!this.eatP(",")) break;
      }
      this.expectP(")");
      return this.at({ p: "tag", tag: name, args }, start);
    }
    if (/^[A-Z]/.test(name)) return this.at({ p: "tag", tag: name }, start);
    return this.at({ p: "bind", name }, start);
  }

  // ── expressions ────────────────────────────────────────────────────────

  expr(ctx: ExprCtx = {}): Expr {
    return this.binary(PREC_OR, ctx);
  }

  private binary(minPrec: number, ctx: ExprCtx): Expr {
    const start = this.t;
    let left = this.unary(minPrec, ctx);
    for (;;) {
      const op = this.binaryOp();
      if (!op) return left;
      const prec = BINARY_PREC[op]!;
      if (prec < minPrec) return left;
      this.bump();
      if (op === "..") {
        const to = this.binary(prec + 1, ctx);
        left = this.at({ op: "range", from: left, to }, start);
        continue;
      }
      const right = this.binary(prec + 1, ctx);
      const bop = (op === "⊆" ? "subseteq" : op) as BinaryOp;
      left = this.at({ op: "binary", bop, left, right }, start);
      if (prec === PREC_CMP && this.binaryOp() && BINARY_PREC[this.binaryOp()!] === PREC_CMP) {
        this.fail("Comparisons do not chain; add parentheses.");
      }
    }
  }

  private binaryOp(): string | undefined {
    const t = this.t;
    if (t.kind === "punct" && t.text in BINARY_PREC) return t.text;
    if (t.kind === "ident" && (t.text === "and" || t.text === "or" || t.text === "in")) return t.text;
    return undefined;
  }

  private unary(minPrec: number, ctx: ExprCtx): Expr {
    const start = this.t;
    if (this.isW("not") && minPrec <= PREC_NOT) {
      this.bump();
      return this.at({ op: "unary", uop: "not", of: this.binary(PREC_NOT, ctx) }, start);
    }
    if (this.isP("-")) {
      this.bump();
      return this.at({ op: "unary", uop: "neg", of: this.unary(PREC_UNARY, ctx) }, start);
    }
    return this.postfix(ctx);
  }

  private postfix(ctx: ExprCtx): Expr {
    const start = this.t;
    let e = this.primary(ctx);
    for (;;) {
      if (this.isP(".") && this.la(1).kind === "ident") {
        this.bump();
        e = this.at({ op: "field", of: e, name: this.bump().text }, start);
      } else if (this.isP("(") && !this.t.nl) {
        // A `(` on a new line starts a new statement, not a call.
        e = this.at({ op: "call", callee: e, args: this.args() }, start);
      } else if (this.isP("?") && !this.t.nl) {
        this.bump();
        e = this.at({ op: "try", of: e }, start);
      } else if (
        this.isP("{") &&
        !this.t.nl &&
        !ctx.noStruct &&
        e.op === "var" &&
        /^[A-Z]/.test(e.name)
      ) {
        e = this.at(this.recordLit(e.name), start);
      } else {
        return e;
      }
    }
  }

  private recordLit(type: string): Expr {
    this.expectP("{");
    const fields: Record<string, Expr> = Object.create(null);
    while (!this.isP("}")) {
      const t = this.t;
      const name = this.ident("a field name");
      if (name in fields) this.dup("field", name, t);
      if (this.eatP(":")) fields[name] = this.expr();
      else fields[name] = this.at({ op: "var", name }, t);
      if (!this.eatP(",")) break;
    }
    this.expectP("}");
    return { op: "record", type, fields };
  }

  primary(ctx: ExprCtx): Expr {
    const t = this.t;
    switch (t.kind) {
      case "int":
      case "dec": {
        this.bump();
        if (this.t.kind === "ident" && CURRENCY.test(this.t.text)) {
          const currency = this.bump().text;
          const [whole, frac = ""] = t.text.replace(/[kM]$/, "").split(".");
          let micros: number | undefined;
          if (t.kind === "int") micros = t.num! * 1_000_000;
          else {
            if (frac.length > 6) this.fail(`Amount ${t.text} has more than six decimal places.`, t);
            micros = Number(BigInt(whole! + frac.padEnd(6, "0")));
          }
          if (!Number.isSafeInteger(micros)) this.fail(`Amount ${t.text} ${currency} is too large.`, t);
          return this.at({ op: "money", micros, currency }, t);
        }
        if (t.kind === "int") return this.at({ op: "int", value: t.num! }, t);
        return this.at({ op: "dec", value: t.text }, t);
      }
      case "duration":
        this.bump();
        return this.at({ op: "duration", ms: t.num! }, t);
      case "string":
        this.bump();
        return this.at(this.template("template", t.parts ?? []), t);
      case "prompt":
        this.bump();
        return this.at(this.template("prompt", t.parts ?? []), t);
      case "punct":
        if (t.text === "(") {
          this.bump();
          const e = this.expr();
          this.expectP(")");
          return e;
        }
        if (t.text === "[") {
          this.bump();
          const items: Expr[] = [];
          while (!this.isP("]")) {
            items.push(this.expr());
            if (!this.eatP(",")) break;
          }
          this.expectP("]");
          return this.at({ op: "list", items }, t);
        }
        if (t.text === "{" && this.isP("}", this.la(1))) {
          this.bump();
          this.bump();
          return this.at({ op: "set", items: [] }, t);
        }
        break;
      case "ident":
        return this.keywordExpr(t, ctx);
    }
    return this.fail(`Expected an expression but found ${this.describe()}.`);
  }

  private keywordExpr(t: Token, ctx: ExprCtx): Expr {
    switch (t.text) {
      case "true":
      case "false":
        this.bump();
        return this.at({ op: "bool", value: t.text === "true" }, t);
      case "delegate":
        return this.at(this.delegateExpr(), t);
      case "spawn": {
        this.bump();
        const agent = this.ident("an agent name");
        this.expectP(".");
        const skill = this.ident("a skill name");
        return this.at({ op: "spawn", agent, skill, args: this.args() }, t);
      }
      case "await":
        this.bump();
        return this.at({ op: "await", of: this.unary(PREC_UNARY, ctx) }, t);
      case "verify":
        return this.at(this.verifyExpr(), t);
      case "infer": {
        this.bump();
        const type = this.typeExpr();
        this.expectW("from");
        const e: Expr = { op: "infer", type, from: this.binary(PREC_OR, { noStruct: true }) };
        if (this.eatW("using")) e.using = this.expr();
        return this.at(e, t);
      }
      case "effect": {
        this.bump();
        const name = this.qname();
        const e: Expr = { op: "effect", name, args: this.args() };
        if (this.eatW("idempotent_by")) e.idempotent_by = this.expr();
        if (this.eatW("compensate")) e.compensate = this.qname();
        return this.at(e, t);
      }
      case "switch": {
        this.bump();
        const on = this.expr({ noStruct: true });
        this.expectP("{");
        const cases: Array<{ pattern: Pattern; then: Expr }> = [];
        while (!this.isP("}")) {
          const ct = this.t;
          const pattern = this.pattern();
          this.expectP("=>");
          const bt = this.t;
          const then = this.isP("{") ? this.at({ op: "block" as const, body: this.block() }, bt) : this.expr();
          cases.push(this.at({ pattern, then }, ct));
          this.eatP(",");
        }
        this.expectP("}");
        return this.at({ op: "switch", on, cases }, t);
      }
    }
    // Contextual expression keywords: only when what follows can start an operand.
    if (t.text === "escalate" && startsOperand(this.la(1))) {
      this.bump();
      return this.at({ op: "escalate", to: this.binary(PREC_AND + 1, ctx) }, t);
    }
    if (t.text === "pause") {
      this.bump();
      const e: Expr = { op: "pause" };
      if (this.eatW("and")) e.then = this.binary(PREC_AND + 1, ctx);
      return this.at(e, t);
    }
    if (RESERVED.has(t.text)) this.fail(`Unexpected keyword '${t.text}' in an expression.`);
    this.bump();
    return this.at({ op: "var", name: t.text }, t);
  }

  private delegateExpr(): Expr {
    this.bump();
    const agent = this.ident("an agent name");
    this.expectP(".");
    const skill = this.ident("a skill name");
    const e: Extract<Expr, { op: "delegate" }> = { op: "delegate", agent, skill, args: this.args() };
    for (;;) {
      if (this.isW("with") && this.isW("caps", this.la(1))) {
        this.bump();
        this.bump();
        e.caps = sortCanon(this.exprList());
      } else if (this.isW("budget") && this.isP("{", this.la(1))) e.budget = this.budget();
      else if (this.eatW("isolated")) e.isolated = true;
      else if (this.eatW("timeout")) e.timeout = this.unary(PREC_UNARY, {});
      else if (this.eatW("supervise")) e.supervise = this.callSpec();
      else return e;
    }
  }

  private verifyExpr(): Expr {
    this.bump();
    const value = this.expr();
    this.expectW("against");
    const contract = this.ident("a contract name");
    const e: Extract<Expr, { op: "verify" }> = { op: "verify", value, contract, args: this.args() };
    if (this.isW("on") && this.isW("unmet", this.la(1))) {
      const start = this.bump();
      this.bump();
      this.expectP("(");
      const bind = this.ident("a binding name");
      this.expectP(")");
      this.expectP("=>");
      e.on_unmet = this.at({ bind, then: this.expr() }, start);
    }
    return e;
  }

  private template(op: "template" | "prompt", raw: RawPart[]): Expr {
    const parts: TemplatePart[] = [];
    for (const p of raw) {
      if ("text" in p) {
        parts.push({ text: p.text });
        continue;
      }
      const toks = new Lexer(p.src, p.line, p.col).tokenize();
      const sub = new Parser(toks, this.spans);
      const expr = sub.expr();
      if (sub.t.kind !== "eof") sub.fail(`Unexpected ${sub.describe()} in interpolation.`);
      this.diagnostics.push(...sub.diagnostics);
      parts.push({ expr });
    }
    if (op === "template" && parts.every((p) => "text" in p)) {
      return { op: "text", value: parts.map((p) => (p as { text: string }).text).join("") };
    }
    return { op, parts };
  }
}

const PREC_OR = 1;
const PREC_AND = 2;
const PREC_NOT = 3;
const PREC_CMP = 4;
const PREC_UNARY = 8;

const BINARY_PREC: Record<string, number> = {
  or: PREC_OR,
  and: PREC_AND,
  "==": PREC_CMP,
  "!=": PREC_CMP,
  "<": PREC_CMP,
  "<=": PREC_CMP,
  ">": PREC_CMP,
  ">=": PREC_CMP,
  in: PREC_CMP,
  "⊆": PREC_CMP,
  "..": 5,
  "+": 6,
  "-": 6,
  "*": 7,
  "/": 7,
};

function startsOperand(t: Token): boolean {
  return t.kind === "ident" || t.kind === "string" || t.kind === "int" || (t.kind === "punct" && t.text === "(");
}

/** Sorts a set-like array by the JCS form of its members. */
function sortCanon<T>(items: T[]): T[] {
  return items
    .map((v) => [canonicalize(v as unknown as Json), v] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, v]) => v);
}
