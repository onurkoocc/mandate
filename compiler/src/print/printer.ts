// Prints canonical IR as `.mdt` text (`mandate fmt`). The output parses back
// to the same IR, so the text form stays a projection of the IR (Doc 4 §3.3).
// Comments are not part of the IR and are not printed.
//
// Layout is fixed: definitions are grouped by kind in a stable order and
// sorted by name inside each group; two-space indentation.

import type {
  Arg,
  Budget,
  CallSpec,
  Command,
  Criterion,
  Def,
  EffectRef,
  Expr,
  Param,
  Pattern,
  Program,
  Skill,
  Stmt,
  TemplatePart,
  TypeExpr,
  Verifier,
} from "../ir/types.js";

const KIND_ORDER: Def["kind"][] = ["interface", "component", "environment", "capability", "type", "const", "effect", "extern", "fn", "contract", "agent", "workflow"];

export function printProgram(p: Program): string {
  const out: string[] = [];
  if (p.language !== "mandate/0.1") out.push(p.language.replace("/", " @ "), "");
  out.push(`module ${p.module} @ ${p.version}`);
  if (p.uses?.length) {
    out.push("");
    for (const u of p.uses) out.push(u.names ? `use ${u.module}.{${u.names.join(", ")}}` : `use ${u.module}`);
  }
  const names = Object.keys(p.defs);
  for (const kind of KIND_ORDER) {
    for (const name of names.filter((n) => p.defs[n]!.kind === kind).sort()) {
      out.push("");
      out.push(printDef(name, p.defs[name]!));
    }
  }
  for (const name of names.filter((n) => p.defs[n]!.kind === "workflow").sort()) {
    const wf = p.defs[name] as Extract<Def, { kind: "workflow" }>;
    for (const h of wf.on ?? []) {
      out.push("");
      out.push(`on ${h.event} in ${name} => ${expr(h.then, 0, "")}`);
    }
  }
  for (const [name, t] of Object.entries(p.tests ?? {})) {
    out.push("");
    const lines = [`test ${quoteText(name)} {`];
    if (t.handlers) {
      lines.push("  with handlers {");
      const hs = Object.entries(t.handlers);
      hs.forEach(([k, v], i) => lines.push(`    ${k} = ${expr(v, 0, "    ")}${i < hs.length - 1 ? "," : ""}`));
      lines.push("  }");
    }
    for (const s of t.body) lines.push(stmt(s, "  "));
    lines.push("}");
    out.push(lines.join("\n"));
  }
  return out.join("\n") + "\n";
}

function printDef(name: string, d: Def): string {
  switch (d.kind) {
    case "capability":
      return `capability ${name} = ${expr(d.value, 0, "")}`;
    case "type": {
      const g = d.generics ? `<${d.generics.join(", ")}>` : "";
      return `type ${name}${g} = ${typeDef(d.type)}${d.class ? ` classified ${d.class}` : ""}`;
    }
    case "const":
      return `let ${name}${d.type ? `: ${type(d.type)}` : ""} = ${expr(d.value, 0, "")}`;
    case "effect": {
      const lines = [`effect ${name}(${params(d.params)}) -> ${type(d.returns)}`];
      for (const c of d.requires_caps ?? []) lines.push(`  requires caps ${expr(c, 0, "  ")}`);
      if (d.critical) lines.push("  critical");
      if (d.irreversible) lines.push("  irreversible");
      if (d.idempotency_required) lines.push("  idempotency required");
      if (d.retry_class) lines.push(`  retry_class ${d.retry_class}`);
      if (d.compensation) lines.push(`  compensation ${d.compensation}`);
      return lines.join("\n");
    }
    case "extern": {
      let s = `extern ${d.lang} ${quoteText(d.file)}::${d.symbol}(${params(d.params)}) -> ${type(d.returns)}\n  ${effects(d.effects)}`;
      if (d.idempotent_by) s += `\n  idempotent_by ${expr(d.idempotent_by, 0, "  ")}`;
      return s;
    }
    case "fn": {
      let s = `${d.pub ? "pub " : ""}fn ${name}(${params(d.params)}) -> ${type(d.returns)}`;
      if (d.effects) s += ` ${effects(d.effects)}`;
      if (d.budget) s += `\n  ${budget(d.budget)}`;
      return s + "\n" + block(d.body, "");
    }
    case "contract": {
      const lines = [`contract ${name}(${params(d.params)}) {`];
      for (const r of d.require ?? []) lines.push(`  require ${expr(r, 0, "  ")}`);
      const crit = (kw: string, n: string, c: Criterion): void => {
        lines.push(`  ${kw} ${n} ${quoteText(c.description)}`);
        lines.push(`    by ${verifier(c.by)}`);
      };
      for (const [n, c] of Object.entries(d.accept)) crit("accept", n, c);
      for (const [n, c] of Object.entries(d.invariant ?? {})) crit("invariant", n, c);
      lines.push("}");
      return lines.join("\n");
    }
    case "agent": {
      if (d.remote) {
        const lines = [`agent remote ${name} = ${expr(d.remote.bind, 0, "")}`];
        if (d.remote.version !== undefined) lines.push(`  version ${quoteText(d.remote.version)}`);
        for (const r of d.remote.require ?? []) lines.push(`  require ${expr(r, 0, "  ")}`);
        if (d.remote.trust) lines.push(`  trust ${d.remote.trust}`);
        if (d.caps.length) lines.push(`  caps ${d.caps.map((c) => noStruct(c, "  ")).join(", ")}`);
        lines.push("  skills {");
        for (const [n, s] of Object.entries(d.skills)) lines.push(`    ${skillSig(n, s, true)}`);
        lines.push("  }");
        return lines.join("\n");
      }
      const lines = [`agent ${name} {`];
      if (d.role !== undefined) lines.push(`  role   ${quoteText(d.role)}`);
      if (d.model !== undefined) lines.push(`  model  ${d.model}`);
      if (d.caps.length) lines.push(`  caps   ${d.caps.map((c) => noStruct(c, "  ")).join(", ")}`);
      if (d.budget) lines.push(`  ${budget(d.budget)}`);
      if (d.loop) lines.push(`  loop   ${d.loop}`);
      if (d.progress) {
        const p = d.progress;
        const parts = (["window", "repeats", "stall"] as const).filter((k) => p[k] !== undefined).map((k) => `${k}: ${p[k]}`);
        lines.push(`  progress { ${parts.join(", ")} }`);
      }
      for (const [n, s] of Object.entries(d.skills)) {
        let sig = `  skill ${skillSig(n, s)}`;
        if (s.budget) sig += `\n    ${budget(s.budget)}`;
        if (s.body) sig += "\n" + block(s.body, "  ");
        lines.push(sig);
      }
      lines.push("}");
      return lines.join("\n");
    }
    case "workflow": {
      let s = `workflow ${name}(${params(d.params)}) -> ${type(d.returns)}`;
      s += `\n  caps    ${d.caps.map((c) => noStruct(c, "  ")).join(", ")}`;
      if (d.budget) s += `\n  ${budget(d.budget)}`;
      if (d.ensures) s += `\n  ensures ${noStruct(d.ensures, "  ")}`;
      return s + "\n" + block(d.body, "");
    }
    case "component": {
      const lines = [`component ${name} {`, `  repo     ${quoteText(d.repo)}`, `  root     ${quoteText(d.root)}`, `  lang     ${d.lang}`, `  owner    role ${quoteText(d.owner)}`];
      if (d.build) lines.push(`  build    ${commands(d.build)}`);
      if (d.test) lines.push(`  test     ${commands(d.test)}`);
      if (d.provides) lines.push(`  provides ${d.provides.join(", ")}`);
      if (d.consumes) lines.push(`  consumes ${d.consumes.join(", ")}`);
      lines.push("}");
      return lines.join("\n");
    }
    case "interface":
      return [`interface ${name} {`, `  protocol ${d.protocol}`, `  spec     ${quoteText(d.spec)}`, "}"].join("\n");
    case "environment": {
      const lines = [`environment ${name} {`, `  class ${d.class}`];
      for (const [rn, r] of Object.entries(d.reads ?? {})) {
        lines.push(`  read ${rn} from ${r.from}`);
        lines.push("sql" in r.query ? `    sql ${quoteParts([{ text: r.query.sql }], false, "    ")}` : `    logs where ${noStruct(r.query.logs, "    ")}`);
        lines.push(`    params (${params(r.params)})`, `    returns ${type(r.returns)}`, `    max_rows ${r.max_rows}`);
      }
      for (const [effect, t] of Object.entries(d.authorize ?? {})) lines.push(`  authorize ${effect} by ${t.by === "policy" ? "policy" : `human(role: ${quoteText(t.role)})`}`);
      lines.push("}");
      return lines.join("\n");
    }
  }
}

function commands(cs: Command[]): string {
  return cs.map((c) => `exec(${quoteText(c.command)}${c.args.length ? `, [${c.args.map(quoteText).join(", ")}]` : ""})`).join(", ");
}

function skillSig(name: string, s: Skill, remote = false): string {
  // Local skills always declare effects; remote ones only when they have any.
  const eff = !remote || s.effects.length ? ` ${effects(s.effects)}` : "";
  return `${name}(${params(s.params)}) -> ${type(s.returns)}${eff}`;
}

function params(ps: Param[]): string {
  return ps.map((p) => `${p.name}: ${type(p.type)}`).join(", ");
}

function effects(es: EffectRef[]): string {
  return `! {${es.map((e) => e.effect + (e.args ? `(${args(e.args, "")})` : "")).join(", ")}}`;
}

function budget(b: Budget): string {
  const parts: string[] = [];
  if (b.tokens !== undefined) parts.push(`tokens: ${count(b.tokens)}`);
  if (b.time) parts.push(`time: ${duration(b.time.ms)}`);
  if (b.spend) parts.push(`spend: ${money(b.spend.micros, b.spend.currency)}`);
  if (b.steps !== undefined) parts.push(`steps: ${b.steps}`);
  return `budget { ${parts.join(", ")} }`;
}

function count(n: number): string {
  if (n !== 0 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (n !== 0 && n % 1000 === 0) return `${n / 1000}k`;
  return String(n);
}

function duration(ms: number): string {
  for (const [u, f] of [["d", 86_400_000], ["h", 3_600_000], ["m", 60_000], ["s", 1000]] as const) {
    if (ms !== 0 && ms % f === 0) return `${ms / f}${u}`;
  }
  return `${ms}ms`;
}

function money(micros: number, currency: string): string {
  const neg = micros < 0;
  const abs = Math.abs(micros);
  const whole = Math.floor(abs / 1_000_000);
  const frac = String(abs % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? "." + frac : ""} ${currency}`;
}

function typeDef(t: TypeExpr): string {
  if ("union" in t) {
    return t.union.map((v) => (v.fields ? `${v.tag}(${params(v.fields)})` : v.tag)).join(" | ");
  }
  return type(t);
}

function type(t: TypeExpr): string {
  if ("ref" in t) return t.args ? `${t.ref}<${t.args.map(type).join(", ")}>` : t.ref;
  if ("record" in t) return `{ ${Object.entries(t.record).map(([k, v]) => `${k}: ${type(v)}`).join(", ")} }`;
  if ("enum" in t) return `enum { ${t.enum.join(", ")} }`;
  if ("refine" in t) return `${type(t.refine)} where ${expr(t.where, 0, "")}`;
  throw new Error("A union type can only appear as a type definition.");
}

function verifier(v: Verifier): string {
  if ("all" in v) return v.all.map(verifier).join(" and ");
  if ("static" in v) return `static ${expr(v.static, PREC_AND + 1, "    ")}`;
  return expr(v.call, PREC_AND + 1, "    ");
}

// ── statements ───────────────────────────────────────────────────────────

function block(body: Stmt[], ind: string): string {
  const lines = [`${ind}{`];
  for (const s of body) lines.push(stmt(s, ind + "  "));
  lines.push(`${ind}}`);
  return lines.join("\n");
}

function stmt(s: Stmt, ind: string): string {
  switch (s.op) {
    case "let":
      return `${ind}let ${s.name}${s.type ? `: ${type(s.type)}` : ""} = ${expr(s.value, 0, ind)}`;
    case "par": {
      const lines = [`${ind}par${s.supervise ? ` supervise ${callSpec(s.supervise)}` : ""} {`];
      for (const [n, e] of Object.entries(s.branches)) lines.push(`${ind}  ${n} = ${expr(e, 0, ind + "  ")}`);
      lines.push(`${ind}}`);
      return lines.join("\n");
    }
    case "if": {
      let out = `${ind}if ${noStruct(s.cond, ind)} ${block(s.then, ind).trimStart()}`;
      if (s.else) out += ` else ${block(s.else, ind).trimStart()}`;
      return out;
    }
    case "loop": {
      const head = s.max_iter !== undefined ? ` max_iter ${s.max_iter}` : s.until ? ` until ${noStruct(s.until, ind)}` : "";
      return `${ind}loop${head} ${block(s.body, ind).trimStart()}`;
    }
    case "return":
      return `${ind}return${s.value ? " " + expr(s.value, 0, ind) : ""}`;
    case "on_error":
      return `${ind}on error(${pattern(s.pattern)}) => ${expr(s.then, 0, ind)}`;
    case "run":
      return `${ind}run ${expr(s.target, 0, ind)} expect ${s.expect}`;
    case "expr": {
      // A statement that starts with `-` would continue the previous one.
      const text = expr(s.value, 0, ind);
      return `${ind}${text.startsWith("-") ? `(${text})` : text}`;
    }
  }
}

function pattern(p: Pattern): string {
  if (p.p === "wild") return "_";
  if (p.p === "bind") return p.name;
  return p.args ? `${p.tag}(${p.args.map(pattern).join(", ")})` : p.tag;
}

function callSpec(c: CallSpec): string {
  return c.args ? `${c.name}(${args(c.args, "")})` : c.name;
}

// ── expressions ──────────────────────────────────────────────────────────

const PREC_AND = 2;
const PREC: Record<string, number> = {
  or: 1, and: 2, "==": 4, "!=": 4, "<": 4, "<=": 4, ">": 4, ">=": 4, in: 4, subseteq: 4, "+": 6, "-": 6, "*": 7, "/": 7,
};
const POSTFIX = 9;

function precOf(e: Expr): number {
  switch (e.op) {
    case "binary":
      return PREC[e.bop]!;
    case "range":
      return 5;
    case "unary":
      return e.uop === "not" ? 3 : 8;
    case "delegate":
    case "verify":
    case "infer":
    case "effect":
    case "switch":
    case "escalate":
    case "pause":
    case "spawn":
    case "await":
    case "block":
      return 0;
    default:
      return POSTFIX;
  }
}

function noStruct(e: Expr, ind: string): string {
  const s = expr(e, 0, ind);
  return containsRecord(e) ? `(${s})` : s;
}

function containsRecord(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  if ((e as { op?: string }).op === "record") return true;
  return Object.values(e as object).some(containsRecord);
}

function expr(e: Expr, minPrec: number, ind: string): string {
  const s = exprInner(e, ind);
  return precOf(e) < minPrec ? `(${s})` : s;
}

function exprInner(e: Expr, ind: string): string {
  switch (e.op) {
    case "int":
      return String(e.value);
    case "dec":
      return e.value;
    case "text":
      return quoteText(e.value);
    case "bool":
      return String(e.value);
    case "money":
      return money(e.micros, e.currency);
    case "duration":
      return duration(e.ms);
    case "list":
      return `[${e.items.map((i) => expr(i, 0, ind)).join(", ")}]`;
    case "set":
      if (e.items.length) throw new Error("Only the empty set literal has a text form.");
      return "{}";
    case "template":
      return quoteParts(e.parts, false, ind);
    case "prompt":
      return "prompt" + quoteParts(e.parts, true, ind);
    case "var":
      return e.name;
    case "field":
      return `${expr(e.of, POSTFIX, ind)}.${e.name}`;
    case "call":
      return `${expr(e.callee, POSTFIX, ind)}(${args(e.args, ind)})`;
    case "try":
      return `${expr(e.of, POSTFIX, ind)}?`;
    case "unary":
      return e.uop === "not" ? `not ${expr(e.of, 3, ind)}` : `-${expr(e.of, 8, ind)}`;
    case "binary": {
      const p = PREC[e.bop]!;
      const op = e.bop === "subseteq" ? "⊆" : e.bop;
      return `${expr(e.left, p, ind)} ${op} ${expr(e.right, p + 1, ind)}`;
    }
    case "range":
      return `${expr(e.from, 5, ind)}..${expr(e.to, 6, ind)}`;
    case "record": {
      const fs = Object.entries(e.fields).map(([k, v]) => (v.op === "var" && v.name === k ? k : `${k}: ${expr(v, 0, ind)}`));
      return `${e.type} { ${fs.join(", ")} }`;
    }
    case "infer": {
      let s = `infer ${type(e.type)} from ${noStruct(e.from, ind)}`;
      if (e.using) s += ` using ${expr(e.using, 0, ind)}`;
      return s;
    }
    case "delegate": {
      let s = `delegate ${e.agent}.${e.skill}(${args(e.args, ind)})`;
      if (e.caps) s += ` with caps ${e.caps.map((c) => noStruct(c, ind)).join(", ")}`;
      if (e.budget) s += ` ${budget(e.budget)}`;
      if (e.isolated) s += " isolated";
      if (e.timeout) s += ` timeout ${expr(e.timeout, 8, ind)}`;
      if (e.supervise) s += ` supervise ${callSpec(e.supervise)}`;
      return s;
    }
    case "spawn":
      return `spawn ${e.agent}.${e.skill}(${args(e.args, ind)})`;
    case "await":
      return `await ${expr(e.of, 8, ind)}`;
    case "verify": {
      let s = `verify ${expr(e.value, 1, ind)} against ${e.contract}(${args(e.args, ind)})`;
      if (e.on_unmet) s += `\n${ind}  on unmet(${e.on_unmet.bind}) => ${expr(e.on_unmet.then, 0, ind + "  ")}`;
      return s;
    }
    case "effect": {
      let s = `effect ${e.name}(${args(e.args, ind)})`;
      if (e.idempotent_by) s += `\n${ind}  idempotent_by ${expr(e.idempotent_by, 0, ind + "  ")}`;
      if (e.compensate) s += `\n${ind}  compensate    ${e.compensate}`;
      return s;
    }
    case "escalate":
      return `escalate ${expr(e.to, PREC_AND + 1, ind)}`;
    case "pause":
      return e.then ? `pause and ${expr(e.then, PREC_AND + 1, ind)}` : "pause";
    case "switch": {
      const lines = [`switch ${noStruct(e.on, ind)} {`];
      for (const c of e.cases) {
        const then = c.then.op === "block" ? block(c.then.body, ind + "  ").trimStart() : expr(c.then, 0, ind + "  ");
        lines.push(`${ind}  ${pattern(c.pattern)} => ${then}`);
      }
      lines.push(`${ind}}`);
      return lines.join("\n");
    }
    case "block":
      return block(e.body, ind).trimStart();
  }
}

function args(as: Arg[], ind: string): string {
  return as.map((a) => (a.name !== undefined ? `${a.name}: ` : "") + expr(a.value, 0, ind)).join(", ");
}

function escapeText(s: string, multiline: boolean): string {
  let out = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\{/g, "\\{").replace(/\}/g, "\\}");
  out = out.replace(/\t/g, "\\t").replace(/\r/g, "\\r");
  if (!multiline) out = out.replace(/\n/g, "\\n");
  return out;
}

function quoteText(s: string): string {
  return `"${escapeText(s, false)}"`;
}

function quoteParts(parts: TemplatePart[], forceTriple: boolean, ind: string): string {
  const triple = forceTriple || parts.some((p) => "text" in p && p.text.includes("\n"));
  const body = parts
    .map((p) => {
      if ("text" in p) return escapeText(p.text, triple);
      const inner = expr(p.expr, 0, ind);
      if (inner.includes('"')) throw new Error("String literals cannot appear inside an interpolation.");
      return `{${inner}}`;
    })
    .join("");
  return triple ? `"""${body}"""` : `"${body}"`;
}
