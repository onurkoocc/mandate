// Inputs about errors: each position that asks for a name, a string, a token
// or a word, with the wrong thing there; what happens after an error; and
// the limits. Each is `[name, input]`, or `[name, parts]` where `parts` is
// `[[text, count], …]`. No imports (see lexical.ts).

const H = "module m @ 0.1\n";
const H2 = "mandate @ 0.2\n\nmodule m @ 0.1\n";
const H3 = "mandate @ 0.3\n\nmodule m @ 0.1\n";
const H4 = "mandate @ 0.4\n\nmodule m @ 0.1\n";

/** A position that takes a name: where `@@` goes, and the language it needs. */
interface NamePos {
  what: string;
  /** The program, with `@@` where the name goes. */
  at: string;
  /** The wrong token cannot be put there: the parser has already seen a name. */
  reservedOnly?: true;
}

const body = (stmt: string): string => `${H}fn f() -> Int {\n  ${stmt}\n}\n`;

/** Every position the parser asks for a name in, by the words of its message. */
const NAME_POSITIONS: NamePos[] = [
  { what: "a name", at: `${H}let @@ = 1\n` },
  { what: "a name", at: body("let @@ = 1") },
  { what: "a name", at: `module @@ @ 0.1\n` },
  { what: "a name", at: `${H}type T = @@\n` },
  { what: "a binding name", at: `${H}let x = verify d against R() on unmet(@@) => 1\n` },
  { what: "a branch name", at: body("par { @@ = 1 }") },
  { what: "a budget field", at: `${H}fn f() -> Int budget { @@: 1 } {\n}\n` },
  { what: "a capability name", at: `${H}capability @@ = x\n` },
  { what: "a component field", at: `${H3}component c {\n  @@\n}\n` },
  { what: "a component name", at: `${H3}environment e {\n  class public\n  read a from @@ sql "x" params () returns R max_rows 1\n}\n` },
  { what: "a component name", at: `${H3}let x = changeset(p) {\n  member @@ = e.f()\n}\n` },
  { what: "a contract name", at: `${H}contract @@() {\n}\n` },
  { what: "a contract name", at: `${H}let x = verify d against @@()\n` },
  { what: "a criterion name", at: `${H}contract C() {\n  accept @@ "d" by f()\n}\n` },
  { what: "a data class", at: `${H}type T = Text classified @@\n` },
  { what: "a data class", at: `${H4}workflow w() -> Int\n  envelope { spawn { max_class: @@ } }\n{\n}\n` },
  { what: "a data class", at: `${H3}environment e {\n  class @@\n}\n` },
  { what: "a field name", at: `${H}type T = { @@: Int }\n` },
  { what: "a field name", at: `${H}let x = T { @@ }\n` },
  { what: "a function name", at: `${H}fn @@() -> Int {\n}\n` },
  { what: "a host language", at: `${H}extern @@ "f.py"::s() -> Int ! {}\n` },
  { what: "a host symbol", at: `${H}extern py "f.py"::@@() -> Int ! {}\n` },
  { what: "a language", at: `${H3}component c {\n  lang @@\n}\n` },
  { what: "a loop strategy", at: `${H2}agent a {\n  loop @@\n}\n` },
  { what: "a member name", at: `${H3}let x = changeset(p) {\n  order @@\n}\n` },
  { what: "a model tier", at: `${H}agent a {\n  model @@\n}\n` },
  { what: "a name for one element", at: `${H4}let x = map @@ in xs {\n}\n`, reservedOnly: true },
  { what: "a parameter name", at: `${H}fn f(@@: Int) -> Int {\n}\n` },
  { what: "a pattern", at: body("on error(@@) => 1") },
  { what: "a progress field", at: `${H2}agent a {\n  progress { @@: 1 }\n}\n` },
  { what: "a protocol", at: `${H3}interface I {\n  protocol @@\n}\n` },
  { what: "a read name", at: `${H3}environment e {\n  class public\n  read @@ from c sql "x" params () returns R max_rows 1\n}\n` },
  { what: "a retry class", at: `${H}effect e() -> Unit\n  retry_class @@\n` },
  { what: "a role", at: `${H4}workflow w() -> Int\n  envelope { owner @@ }\n{\n}\n` },
  { what: "a role", at: `${H4}workflow w() -> Int\n  envelope { approve e by @@ }\n{\n}\n` },
  { what: "a role name", at: `${H4}role @@ "d"\n`, reservedOnly: true },
  { what: "a skill name", at: `${H}agent a {\n  skill @@() -> Int ! {}\n}\n` },
  { what: "a skill name", at: `${H}agent remote R = a2a("u")\n  skills {\n    @@() -> Int\n  }\n` },
  { what: "a skill name", at: `${H}let x = delegate A.@@()\n` },
  { what: "a skill name", at: `${H}let x = spawn A.@@()\n` },
  { what: "a spawn field", at: `${H4}workflow w() -> Int\n  envelope { spawn { @@: 1 } }\n{\n}\n` },
  { what: "a strategy name", at: body("par supervise @@ { }") },
  { what: "a trust level", at: `${H}agent remote R = a2a("u")\n  trust @@\n` },
  { what: "a type name", at: `${H}type @@ = Int\n` },
  { what: "a type parameter", at: `${H}type T<@@> = Int\n` },
  { what: "a variant name", at: `${H}type T = A | @@\n` },
  { what: "a workflow name", at: `${H}workflow @@() -> Int\n  caps K\n{\n}\n` },
  { what: "a workflow name", at: `${H}on done in @@ => f()\n` },
  { what: "additive, breaking or none", at: `${H3}let x = changeset(p) {\n  change I @@\n}\n` },
  { what: "an agent name", at: `${H}agent @@ {\n}\n` },
  { what: "an agent name", at: `${H}let x = delegate @@.b()\n` },
  { what: "an agent name", at: `${H}let x = spawn @@.b()\n` },
  { what: "an effect name", at: `${H}test "t" {\n  with handlers {\n    @@ = x\n  }\n}\n` },
  { what: "an enum member", at: `${H}type T = enum { @@ }\n` },
  { what: "an environment name", at: `${H3}environment @@ {\n}\n`, reservedOnly: true },
  { what: "an event name", at: `${H}on @@ in W => f()\n` },
  { what: "an expected outcome", at: `${H}test "t" {\n  run W() expect @@\n}\n` },
  { what: "an imported name", at: `${H}use std.{@@}\n` },
  { what: "an interface field", at: `${H3}interface I {\n  @@\n}\n` },
  { what: "an interface name", at: `${H3}component c {\n  provides @@\n}\n` },
  { what: "an interface name", at: `${H3}let x = changeset(p) {\n  change @@ none\n}\n` },
  { what: "member, order, change or approve", at: `${H3}let x = changeset(p) {\n  @@\n}\n` },
];

/** Every name position with something that is not a name there, then with a reserved word there. */
export const namePositions: Array<[string, string]> = NAME_POSITIONS.flatMap((p, i): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const label = `${p.what} (#${i + 1})`;
  if (!p.reservedOnly) out.push([`${label}: a number where the name goes`, p.at.replace("@@", "1")]);
  out.push([`${label}: a reserved word where the name goes`, p.at.replace("@@", "in")]);
  return out;
});

interface StringPos {
  what: string;
  at: string;
  /** The wrong kind of token cannot be put there. */
  interpolationOnly?: true;
}

const STRING_POSITIONS: StringPos[] = [
  { what: "a command", at: `${H3}component c {\n  build exec(@@)\n}\n` },
  { what: "a criterion description", at: `${H}contract C() {\n  accept a @@ by f()\n}\n` },
  { what: "a host file path", at: `${H}extern ts @@::f() -> Int ! {}\n` },
  { what: "a repository, owner/name", at: `${H3}component c {\n  repo @@\n}\n` },
  { what: "a role description", at: `${H}agent a {\n  role @@\n}\n` },
  { what: "a role description", at: `${H4}role r @@\n`, interpolationOnly: true },
  { what: "a role", at: `${H3}component c {\n  owner role @@\n}\n` },
  { what: "a role", at: `${H3}environment e {\n  class public\n  authorize a by human(role: @@)\n}\n` },
  { what: "a role", at: `${H3}let x = changeset(p) {\n  member a = e.f() approved_by role @@\n}\n` },
  { what: "a role", at: `${H3}let x = changeset(p) {\n  approve role @@\n}\n` },
  { what: "a spec path", at: `${H3}interface I {\n  spec @@\n}\n` },
  { what: "a test name", at: `${H}test @@ {\n}\n`, interpolationOnly: true },
  { what: "a version string", at: `${H}agent remote R = a2a("u")\n  version @@\n` },
  { what: "an absolute path", at: `${H3}component c {\n  root @@\n}\n` },
  { what: "an argument", at: `${H3}component c {\n  build exec("x", [@@])\n}\n` },
  { what: "an SQL query", at: `${H3}environment e {\n  class public\n  read a from c sql @@ params () returns R max_rows 1\n}\n` },
  { what: 'a file pattern, e.g. "deploy/**"', at: `${H3}component c {\n  governance @@\n}\n` },
];

export const stringPositions: Array<[string, string]> = STRING_POSITIONS.flatMap((p, i): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  const label = `${p.what} (#${i + 1})`;
  if (!p.interpolationOnly) out.push([`${label}: a number where the string goes`, p.at.replace("@@", "1")]);
  out.push([`${label}: an interpolation where the string goes`, p.at.replace("@@", '"x {y}"')]);
  return out;
});

/** A position that takes a token or a word, with the program that has it missing. */
export const missing: Array<[string, string]> = [
  ["a missing `!` after an extern's return type", `${H}extern ts "a.ts"::f() -> Int\n`],
  ["a missing `(` after a function's name", `${H}fn f -> Int {\n}\n`],
  ["a missing `[` after a command", `${H3}component c {\n  build exec("x", "y")\n}\n`],
  ["a missing `=>` after a handler's workflow", `${H}on done in W f()\n`],
  ["a missing `>` after type arguments", `${H}type T = A<B C>\n`],
  ["a missing `>` after type parameters", `${H}type T<A B> = A\n`],
  ["a missing `->` after a function's parameters", `${H}fn f() {\n}\n`],
  ["a missing `against` after a verify's value", `${H}let x = verify d R()\n`],
  ["a missing `by` after a criterion's description", `${H}contract C() {\n  accept a "A" f()\n}\n`],
  ["a missing `caps` after `requires`", `${H}effect e() -> Unit\n  requires x\n`],
  ["a missing `envelope` after `within`", `${H4}let x = plan A.b(1) within\n`],
  ["a missing `exec` in a command", `${H3}component c {\n  build run("x")\n}\n`],
  ["a missing `expect` after a run's target", `${H}test "t" {\n  run W()\n}\n`],
  ["a missing `fn` after `pub`", `${H}pub let x = 1\n`],
  ["a missing `from` after an infer's type", `${H}let x = infer T x\n`],
  ["a missing `human` after `by`", `${H3}environment e {\n  class public\n  authorize a by robot\n}\n`],
  ["a missing `in` after a handler's event", `${H}on done W => f()\n`],
  ["a missing `max_rows` after a read's returns", `${H3}environment e {\n  class public\n  read a from c sql "x" params () returns R\n}\n`],
  ["a missing `params` after a read's source", `${H3}environment e {\n  class public\n  read a from c sql "x" returns R max_rows 1\n}\n`],
  ["a missing `required` after `idempotency`", `${H}effect e() -> Unit\n  idempotency\n`],
  ["a missing `returns` after a read's params", `${H3}environment e {\n  class public\n  read a from c sql "x" params () max_rows 1\n}\n`],
  ["a missing `role` after `owner`", `${H3}component c {\n  owner "o"\n}\n`],
  ["a missing `where` after a read's logs", `${H3}environment e {\n  class public\n  read a from c logs x\n}\n`],
  ["a missing `within` after a plan", `${H4}let x = plan A.b(1)\n`],
  ["the wrong word where `envelope` is expected", `${H4}let x = plan A.b(1) within caps\n`],
];

/** The three forms of what the parser found: end of input, a string, and a token. */
export const found: Array<[string, string]> = [
  ["found: end of input", `${H}type T =`],
  ["found: a string", `${H}type T = "x"\n`],
  ["found: a prompt template reads as a string", `${H}type T = prompt"x"\n`],
  ["found: a multi-line string reads as a string", `${H}type T = """x"""\n`],
  ["found: a number", `${H}type T = 12\n`],
  ["found: a decimal", `${H}type T = 1.5\n`],
  ["found: a count with a suffix", `${H}type T = 2k\n`],
  ["found: a duration", `${H}type T = 5m\n`],
  ["found: punctuation of two characters", `${H}type T = =>\n`],
  ["found: the subset sign", `${H}type T = \u2286\n`],
];

/** Positions that report a duplicate: each kind, and the ones in other tables. */
export const duplicates: Array<[string, string]> = [
  ["a duplicate enum member", `${H}type T = enum { a, b, a }\n`],
  ["a duplicate variant", `${H}type T = A | B | A\n`],
  ["a duplicate record type field", `${H}type T = { a: Int, a: Text }\n`],
  ["a duplicate envelope field", `${H4}workflow w() -> Int\n  envelope { owner a owner b }\n{\n}\n`],
  ["a duplicate envelope caps field", `${H4}workflow w() -> Int\n  envelope { caps A caps B }\n{\n}\n`],
  ["a duplicate envelope budget field", `${H4}workflow w() -> Int\n  envelope { budget { steps: 1 } budget { steps: 2 } }\n{\n}\n`],
  ["a duplicate envelope spawn field", `${H4}workflow w() -> Int\n  envelope { spawn { max_class: public } spawn { max_class: internal } }\n{\n}\n`],
  ["a duplicate spawn field", `${H4}workflow w() -> Int\n  envelope { spawn { max_class: public, max_class: internal } }\n{\n}\n`],
  ["a duplicate approval", `${H4}workflow w() -> Int\n  envelope { approve e by r approve e by s }\n{\n}\n`],
  ["a duplicate definition of a different kind", `${H}let x = 1\ntype x = Int\nfn x() -> Int {\n}\n`],
  ["a duplicate definition: the later one wins in the IR but keeps the first one's place", `${H}let a = 1\nlet b = 2\nlet a = 3\n`],
  ["a duplicate field in a record literal and one in a record type", `${H}type T = { a: Int, a: Int }\nlet x = T { b: 1, b: 2 }\n`],
  ["a duplicate budget field is reported before the field's value is checked", `${H}fn f() -> Int budget { steps: 1, steps: 2 } {\n}\n`],
  ["a duplicate parameter in a skill", `${H}agent a {\n  skill s(x: Int, x: Int) -> Int ! {}\n}\n`],
  ["a duplicate parameter in an effect", `${H}effect e(x: Int, x: Int) -> Int\n`],
  ["a duplicate parameter in a union variant", `${H}type T = A(x: Int, x: Int)\n`],
  ["a duplicate component field", `${H3}component c {\n  repo "a/b"\n  repo "c/d"\n  root "/r"\n  lang py\n  owner role "o"\n}\n`],
  ["a duplicate environment field", `${H3}environment e {\n  class public\n  class internal\n}\n`],
  ["a duplicate interface field", `${H3}interface I {\n  protocol oauth\n  protocol event\n  spec "s"\n}\n`],
];

/** What happens after an error: the parser stops at the first one it cannot read past. */
export const recovery: Array<[string, string]> = [
  ["two independent syntax errors: only the first is reported", `${H}let = 1\nlet y =\n`],
  ["three independent syntax errors: only the first is reported", `${H}type = Int\nfn () -> Int {\n}\nlet = 3\n`],
  ["a syntax error in the first definition hides a valid second one", `${H}let = 1\nlet y = 2\n`],
  ["a syntax error in the second definition: the first is read and dropped", `${H}let x = 1\nlet = 2\n`],
  ["a syntax error inside a block", `${H}fn f() -> Int {\n  let = 1\n  let y =\n}\n`],
  ["a syntax error in a nested expression reports the innermost", `${H}let x = f(g(h(1 2), 2), 3)\n`],
  ["a syntax error after a lexical error's position is not reached", `${H}let = 1\nlet y = 2 $\n`],
  ["a lexical error after a syntax error is the one reported", `${H}let x = (\nlet y = $\n`],
  ["a lexical error in the last line wins over a syntax error in the first", `${H}let = 1\n\n\nlet y = 2\nlet z = ~\n`],
  ["two lexical errors: only the first is reported", `${H}let x = $\nlet y = %\n`],
  ["an unterminated string at the end hides a syntax error before it", `${H}let = 1\nlet y = "abc`],
  ["a malformed version after a syntax error is the one reported", `${H}let = 1\nlet y = 1\nmodule n @ 1..2\n`],
  ["a malformed version in the module line", "module m @ 1..2\nlet = 1\n"],
  ["an invalid escape later in the file wins over an earlier syntax error", `${H}let = 1\nlet s = "\\q"\n`],
  ["a number out of range later in the file wins over an earlier syntax error", `${H}let = 1\nlet s = 99999999999999999999\n`],
  ["an error in an interpolation is reported at its own position", `${H}let a = "x {y +}" \nlet = 2\n`],
  ["a syntax error before a string whose interpolation has a lexical error: an interpolation is only read when its string is parsed", `${H}let = "x {y $}"\n`],
  ["a duplicate, then a duplicate: both are reported, in order", `${H}let a = 1\nlet a = 2\nlet b = 1\nlet b = 2\n`],
  ["a duplicate, then a syntax error: the duplicate is lost", `${H}let a = 1\nlet a = 2\nlet = 3\n`],
  ["a duplicate, then a lexical error: the duplicate is lost", `${H}let a = 1\nlet a = 2\nlet b = $\n`],
  ["a duplicate parameter, then a duplicate definition: both are reported, in order", `${H}fn f(a: Int, a: Int) -> Int {\n}\nlet f = 1\n`],
  ["a duplicate inside an interpolation is reported when the string has been read", `${H}let a = "{T { f: 1, f: 2 }}"\nlet a = 2\n`],
  ["a duplicate before an interpolation's duplicate", `${H}let a = 1\nlet a = "{T { f: 1, f: 2 }}"\n`],
  ["a duplicate inside an interpolation, then a syntax error: the duplicate is lost", `${H}let a = "{T { f: 1, f: 2 }}"\nlet = 2\n`],
  ["a duplicate inside an interpolation, then an interpolation that cannot be read", `${H}let a = "{T { f: 1, f: 2 }}"\nlet b = "{c +}"\n`],
  ["a language version that is not read, then a duplicate, then a missing handler target: in that order", `mandate @ 0.9\n\nmodule m @ 0.1\non e in Gone => f()\nlet a = 1\nlet a = 2\n`],
  ["a language version that is not read, then a duplicate, then a syntax error: only the syntax error", `mandate @ 0.9\n\nmodule m @ 0.1\nlet a = 1\nlet a = 2\nlet = 1\n`],
  ["a handler with a missing target, then a syntax error: only the syntax error", `${H}on e in Gone => f()\nlet = 1\n`],
  ["parse diagnostics come before schema diagnostics", `${H}use std.{}\nlet a = 1\nlet a = 2\n`],
  ["a program that reads and fails the schema: the program and its spans come back", `${H}type T = enum { }\n`],
  ["a program that reads and fails the schema in two places: the diagnostics follow the schema's order", `${H}use std.{}\ntype T = enum { }\n`],
  ["a program that reads, with a parse diagnostic and schema diagnostics", `${H}let a = 1\nlet a = 2\ntype T = enum { }\n`],
  ["a schema diagnostic on a node with no span of its own is placed at the nearest enclosing node", `${H}use std.{}\n`],
  ["a 0.4 definition in a 0.1 file: a version diagnostic from the schema step", `${H}role r "R"\n`],
  ["a 0.3 definition in a 0.1 file", `${H}interface I {\n  protocol oauth\n  spec "s"\n}\n`],
  ["a 0.2 field in a 0.1 file", `${H}agent a {\n  loop react\n}\n`],
  ["a program with a parse error at the very first token", "let x = 1"],
  ["a program whose only error is at the end of input", `${H}fn f() -> Int {\n`],
  ["an error at a token after a very long line", `${H}let x = [${"1, ".repeat(100)}1] let = 2\n`],
];

/** The pieces `[[text, count], …]` of an input too large to write out. */
type Parts = Array<[string, number]>;
const MiB = 1024 * 1024;

const wrap = (before: string, unit: string, after: string, n: number, close: string): Parts => [[H + before, 1], [unit, n], [after, 1], [close, n], ["\n", 1]];

/** `let x = (((1)))` and the like: the family, the parts for n levels. */
const family = (name: string, n: number): Parts => {
  switch (name) {
    case "parens": return wrap("let x = ", "(", "1", n, ")");
    case "lists": return wrap("let x = ", "[", "", n, "]");
    case "neg": return [[H + "let x = ", 1], ["-", n], ["1\n", 1]];
    case "not": return [[H + "let x = ", 1], ["not ", n], ["true\n", 1]];
    case "blocks": return [[H + "fn f() -> Int {\n", 1], ["if true {\n", n], ["}\n", n], ["}\n", 1]];
    case "elseif": return [[H + "fn f() -> Int {\nif true { } ", 1], ["else if true { } ", n], ["}\n", 1]];
    case "types": return wrap("type T = ", "List<", "Int", n, ">");
    case "records": return wrap("type T = ", "{a: ", "Int", n, "}");
    case "sums": return [[H + "let x = ", 1], ["1 + ", n - 1], ["1\n", 1]];
    case "calls": return [[H + "let x = a", 1], ["(1)", n], ["\n", 1]];
    case "fields": return [[H + "let x = a", 1], [".b", n], ["\n", 1]];
    case "rightsums": return wrap("let x = ", "1 + (", "1", n, ")");
    case "patterns": return [[H + "fn f() -> Int {\n  on error(", 1], ["A(", n], ["x", 1], [")", n], [") => 1\n}\n", 1]];
    case "interpolated lists": return [[H + 'let x = "{', 1], ["[", n], ["]", n], ['}"\n', 1]];
    case "switches": return [[H + "let x = ", 1], ["switch a { _ => ", n], ["1", 1], [" }", n], ["\n", 1]];
    default: throw new Error(name);
  }
};

export const limits: Array<[string, Parts]> = [
  ["an input of exactly the size limit", [["module m @ 0.1\n", 1], [" ", MiB - 15]]],
  ["an input one byte over the size limit", [["module m @ 0.1\n", 1], [" ", MiB - 14]]],
  ["an input over the size limit hides a lexical error", [["$", MiB + 1]]],
  ["an input over the size limit hides a missing module", [["let x = 1\n", 1], [" ", MiB]]],
  ["an input of exactly the size limit in bytes, with two-byte characters in a comment", [["module m @ 0.1\n// ", 1], ["\u00e9", (MiB - 18) / 2]]],
  ["an input over the size limit in bytes by one character of two bytes", [["module m @ 0.1\n// ", 1], ["\u00e9", (MiB - 18) / 2 + 1]]],
  ["an input over the size limit in bytes by characters outside the BMP: four bytes for two code units", [["module m @ 0.1\n// ", 1], ["\u{1F600}", Math.floor((MiB - 18) / 4) + 1]]],
  ["a line of 800 thousand characters, then an error: the column counts them all", [["module m @ 0.1\nlet x = [", 1], ["1,", 400000], ["1] let = 2\n", 1]]],

  // Nesting. For each family: the deepest that reads, and the first that is refused.
  ["parentheses 63 deep", family("parens", 63)],
  ["parentheses 64 deep: refused while reading", family("parens", 64)],
  ["lists nested 30 deep", family("lists", 30)],
  ["lists nested 31 deep: the IR is too deep", family("lists", 31)],
  ["lists nested 65 deep: refused while reading", family("lists", 65)],
  ["a negation 59 deep", family("neg", 59)],
  ["a negation 60 deep: the IR is too deep", family("neg", 60)],
  ["a negation 64 deep: refused while reading", family("neg", 64)],
  ["`not` 59 deep", family("not", 59)],
  ["`not` 60 deep: the IR is too deep", family("not", 60)],
  ["`not` 64 deep: refused while reading", family("not", 64)],
  ["blocks of `if` nested 29 deep", family("blocks", 29)],
  ["blocks of `if` nested 30 deep: the IR is too deep", family("blocks", 30)],
  ["blocks of `if` nested 32 deep: refused while reading", family("blocks", 32)],
  ["an else-if chain 28 long", family("elseif", 28)],
  ["an else-if chain 29 long: the IR is too deep", family("elseif", 29)],
  ["an else-if chain 62 long: refused while reading", family("elseif", 62)],
  ["type arguments nested 29 deep", family("types", 29)],
  ["type arguments nested 30 deep: the IR is too deep", family("types", 30)],
  ["type arguments nested 64 deep: refused while reading", family("types", 64)],
  ["record types nested 29 deep", family("records", 29)],
  ["record types nested 30 deep: the IR is too deep", family("records", 30)],
  ["record types nested 64 deep: refused while reading", family("records", 64)],
  ["a sum of 60 operands (left associative)", family("sums", 60)],
  ["a sum of 61 operands: the IR is too deep (nothing is nested in the text)", family("sums", 61)],
  ["a sum of 1000 operands: the IR is too deep, reported at the first value that is", family("sums", 1000)],
  ["57 calls in a row", family("calls", 57)],
  ["58 calls in a row: the IR is too deep", family("calls", 58)],
  ["59 field accesses in a row", family("fields", 59)],
  ["60 field accesses in a row: the IR is too deep", family("fields", 60)],
  ["a right-nested sum 59 deep", family("rightsums", 59)],
  ["a right-nested sum 60 deep: the IR is too deep", family("rightsums", 60)],
  ["a right-nested sum 64 deep: refused while reading", family("rightsums", 64)],
  ["patterns nested 28 deep", family("patterns", 28)],
  ["patterns nested 29 deep: the IR is too deep", family("patterns", 29)],
  ["patterns nested 63 deep: refused while reading", family("patterns", 63)],
  ["switches nested 19 deep", family("switches", 19)],
  ["switches nested 20 deep: the IR is too deep", family("switches", 20)],
  ["switches nested 64 deep: refused while reading", family("switches", 64)],
  ["lists nested 29 deep in an interpolation", family("interpolated lists", 29)],
  ["lists nested 30 deep in an interpolation: the IR is too deep", family("interpolated lists", 30)],
  ["lists nested 65 deep in an interpolation: refused while reading, counted from the interpolation", family("interpolated lists", 65)],
  [
    "the nesting count starts again inside an interpolation: 40 parentheses outside, 40 inside",
    [[H + "let x = ", 1], ["(", 40], ['"{', 1], ["(", 40], ["1", 1], [")", 40], ['}"', 1], [")", 40], ["\n", 1]],
  ],
  ["an error on the 500th line", [[H, 1], ["let a = 1\n", 498], ["let = 1\n", 1]]],
];
