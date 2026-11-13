// The smallest form of each kind of definition, expression and statement
// the grammar has. Each is `[name, input]`. No imports (see lexical.ts).

const H = "module m @ 0.1\n";
const at = (language: string): string => `mandate @ ${language}\n\nmodule m @ 0.1\n`;
const e = (expr: string): string => `${H}let x = ${expr}\n`;
const st = (stmt: string): string => `${H}fn f() -> Int {\n  ${stmt}\n}\n`;

export const smallest: Array<[string, string]> = [
  // Definitions.
  ["a type", `${H}type T = Int\n`],
  ["a capability", `${H}capability C = c\n`],
  ["a constant", `${H}let x = 1\n`],
  ["a function", `${H}fn f() -> Int {\n}\n`],
  ["an extern", `${H}extern py "f.py"::f() -> Int ! {}\n`],
  ["an effect", `${H}effect e() -> Unit\n`],
  ["an agent", `${H}agent a {\n}\n`],
  ["a remote agent", `${H}agent remote R = r\n`],
  ["a workflow", `${H}workflow w() -> Int\n  caps K\n{\n}\n`],
  ["a contract", `${H}contract C() {\n}\n`],
  ["a role", `${at("0.4")}role r "R"\n`],
  ["a component", `${at("0.3")}component c {\n  repo "a/b"\n  root "/r"\n  lang py\n  owner role "o"\n}\n`],
  ["an interface", `${at("0.3")}interface I {\n  protocol oauth\n  spec "s"\n}\n`],
  ["an environment", `${at("0.3")}environment e {\n  class public\n}\n`],
  ["a test", `${H}test "t" {\n}\n`],
  ["a handler", `${H}workflow w() -> Int\n  caps K\n{\n}\non e in w => 1\n`],
  // Statements.
  ["a let statement", st("let a = 1")],
  ["a par statement", st("par {\n  }")],
  ["an if statement", st("if a {\n  }")],
  ["a loop statement", st("loop {\n  }")],
  ["a return statement", st("return")],
  ["an error handler", st("on error(e) => 1")],
  ["a run statement", `${H}test "t" {\n  run w() expect ok\n}\n`],
  ["an expression statement", st("a")],
  // Expressions.
  ["an integer", e("1")],
  ["a decimal", e("1.5")],
  ["a string", e('"a"')],
  ["a boolean", e("true")],
  ["money", e("1 USD")],
  ["a duration", e("1s")],
  ["a list", e("[]")],
  ["a set", e("{}")],
  ["a template", e('"{a}"')],
  ["a prompt", e('prompt"a"')],
  ["a name", e("a")],
  ["a field access", e("a.b")],
  ["a call", e("f()")],
  ["a try", e("a?")],
  ["a not", e("not a")],
  ["a negation", e("-a")],
  ["a binary operation", e("a + b")],
  ["a range", e("a..b")],
  ["a record literal", e("T {}")],
  ["an infer", e("infer T from a")],
  ["a delegate", e("delegate A.b()")],
  ["a spawn", e("spawn A.b()")],
  ["an await", e("await a")],
  ["a verify", e("verify a against C()")],
  ["an effect call", e("effect e.f()")],
  ["a switch", e("switch a {\n}")],
  ["a switch with a block arm", e("switch a {\n  _ => { }\n}")],
  ["an escalate", e("escalate a")],
  ["a pause", e("pause")],
  ["a changeset", `${at("0.3")}let x = changeset(p) {\n  order a\n  approve role "r"\n}\n`],
  ["a map", `${at("0.4")}let x = map a in b {\n}\n`],
  ["a plan", `${at("0.4")}let x = plan A.b() within envelope\n`],
];
