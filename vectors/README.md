# Vectors

What the TypeScript compiler's strict reader, canonical text and hashes
give, for another implementation to match byte for byte. They are written
by `compiler/test/vectors.test.ts`, which fails when a committed file
differs from what the compiler gives now, and read by the Rust tests in
`crates/mandate-ir/tests/vectors.rs`. To write them again:
`MANDATE_UPDATE_VECTORS=1 npm test`.

They are not conformance cases (`conformance/`): a case states a rule and
is checked against the spec; a vector records what the reference
implementation does, down to the message text and the column.

Every file is ASCII strict JSON within the reader's limits, so any
implementation's reader can read it: characters from U+007F up are written
as `\u` escapes. An input that needs a carriage return, a control
character or a byte order mark carries it in a JSON string, never as a raw
byte in the file.

## reader.json

`{ "format": "mandate/vectors/reader/0.1", "vectors": [ … ] }`. Each vector
has a `name` and exactly one input:

- `input`: the text;
- `input_parts`: `[[text, count], …]`, each text repeated `count` times and
  joined, for inputs too large to write out;
- `input_bytes`: `[[hex, count], …]`, bytes in the same way. They are
  decoded as `readFileSync(file, "utf8")` decodes a file: a byte order mark
  is kept, and each ill-formed UTF-8 sequence becomes U+FFFD.

Then `"ok": true` with the value's `canonical` text (or, when it is longer
than 4096 characters, `canonical_sha256`, the hex SHA-256 of its UTF-8) and
`spans`, each value's `[startLine, startCol, endLine, endCol]` by JSON
Pointer; or `"ok": false` with `diagnostics`, as the compiler writes them
(`code`, `severity`, `message`, `at`, `docs`, `facts`). Columns count UTF-16
code units. Compare spans and diagnostics as values, not by member order.

The TypeScript reader quotes the character it found as one UTF-16 code
unit. Where that is half of a surrogate pair (an unexpected character
outside the Basic Multilingual Plane), its message holds a lone surrogate,
which no vector can carry; there is no such vector. The Rust reader writes
U+FFFD there.

## jcs.json

`{ "format": "mandate/vectors/jcs/0.1", "vectors": [ { "name", "input",
"canonical" } ] }`. `input` is read by the strict reader; `canonical` is its
canonical text.

## hash.json

`{ "format": "mandate/vectors/hash/0.1", "domain", "program", "package" }`:

- `domain`: `{ domain, version, input, hash }`, the domain hash of the value
  `input` reads to;
- `program`: `{ name, input, program, defs }`, the program's hashes, `defs`
  as `[[name, hash], …]` in the order they are computed (UTF-16 order of the
  names);
- `package`: `{ name, program_hash, lock, hash }`, `lock` being the lock as a
  package carries it, as text.

## programs/

One file per program the golden file (`compiler/test/golden/outputs.json`)
pins, named after its path with `/` as `.`:
`{ format: "mandate/vectors/program/0.1", source, kind, language,
canonical, hashes: { program, defs }, lock?, package?, ir }`. `ir` is the
program's IR in the compiler's member order; `canonical` is its canonical
text. Where the program has a lock, `lock` is that lock as a package
carries it (without its `lock` field) and `package` the package hash. A
program's lock is `<name>.lock.json` beside it when that exists
(`reach.mdt` has `reach.lock.json`), else `mandate.lock.json` beside it.

## schema/

What the schema validation of the compiler gives for invalid input, for a
validator that does not use Ajv to give the same raw errors in the same order
and then the same diagnostics. They are written by
`compiler/test/schema-vectors.test.ts` (with `schema-vector-*.ts` beside it),
which fails when a file differs from what the compiler gives now; the same
command writes them again. The test also fails when a keyword of
`spec/ir.schema.json` or `spec/lock.schema.json` has fewer than two cases with a
raw error of that keyword, when an entry of `$defs` has none raised in it, when
a row of the `SINCE` tables of `compiler/src/ir/validate.ts` has no gate case,
and when a behaviour of `schemaDiagnostics` listed below has fewer than three
cases that show it. The files are within the limits of the reader (under 900
KB, integers only, no lone surrogate); a case carries its input as text, since
spans depend on the text.

**Raw error** (`raw_errors`): Ajv's error object as `{ instancePath,
schemaPath, keyword, params, message }` and, where Ajv sets it, `propertyName`
(see below). `params` are Ajv's, whose numbers are all integers.

### ir-invalid-N.json

`{ "format": "mandate/vectors/schema/ir-invalid/0.1", "part": N, "parts": M,
"cases": [ … ] }`. The cases are in one order across the parts (a file stays
under 800 KB, so there may be more than one). A case:

- `name`: unique;
- `base`: which program it was made from (see below);
- `pretty`: the `input` is `JSON.stringify(v, null, 2)` (spans over several
  lines) or compact (one line);
- `input`: the text given to `load(text, "json")`;
- `schema_consulted`: whether `validateIr` runs the schema on it at all. It does
  not for a document that is not a JSON object (E0104 at `""`) or whose
  `language` is missing or not one of the five versions (E0103 at `/language`,
  with `facts: { expected, found }`). For such a case `raw_errors` is what the
  schema validator says if it is run on the value anyway, and `diagnostics` does
  not use it;
- `raw_errors`: the errors of the validator of `validateIr` for the value that
  `input` reads to, in Ajv's order, before anything is dropped;
- `shows`: which of the behaviours below the case shows (empty when it does
  not consult the schema), found by `behavioursOf` in
  `schema-vector-support.ts`;
- `diagnostics`: all of what `load(input, "json").diagnostics` returns, in
  order: `code`, `severity`, `message`, `at` (`path` and `span`, `[startLine,
  startCol, endLine, endCol]`, 1-based, columns in UTF-16 code units, end
  exclusive), `docs` and `facts`. A schema diagnostic is E0104 with `facts: {
  keyword, schema_path }`; a case may also hold E0104 of the version gates when
  its edit made one.

The bases are definitions of the programs the golden file pins (taken from
their source and wrapped as `{ language, module: "vectors.base", version:
"0.1", defs }`, in the language of the program they come from) and a few
written for the forms no golden program uses (`set`, `spawn`, `await`, `try`,
`block`, `run`, `generics`, `pub`, agent `remote`, `loop`, `progress`, `model`,
workflow `ensures`). Each case is a base with one or more edits at JSON
Pointers: remove a member, add an unknown member, put a value of another type,
break an `enum`, `const`, `pattern`, `minimum`, `maximum`, `minLength`,
`minItems`, `uniqueItems`, `minProperties` or `propertyNames`, give an unknown or
missing `op`, `kind`, `p` or `by`. The name of a case says the edit. The test
asserts that the bases hold every definition kind, expression, statement, type
form, pattern, verifier, tier and read source of the schema.

Cases that exist to show one thing carry its name:

- the order of the raw errors: "properties are checked in the order of the
  schema, not of the document", "the items of an array are checked by index",
  "the values of a map are checked in the order of the document", and the three
  cases of names that are array indices (below) or `__proto__`;
- `drops_shallower`, `keeps_at_max_depth`, `additional_depth`,
  `removes_duplicates`, `same_path_order`, `sort_not_code_point`,
  `sort_not_locale`: the behaviours of `schemaDiagnostics`. The test lists, in
  `BEHAVIOUR_CASES`, three or four cases for each, and checks that each shows
  it; many other cases do, and say so in `shows`.

### How the diagnostics follow from the raw errors (`schemaDiagnostics`)

1. Drop the errors with keyword `oneOf` or `if`.
2. `depth(e)` is the number of parts of `instancePath` split at `/` (so `""` is
   1 and `"/a"` is 2), plus 1 for an `additionalProperties` error.
3. Visit the errors in order of falling depth (a stable sort, so equal depths keep
   Ajv's order). An error is dropped when some other error has an
   `instancePath` that starts with its own `instancePath` followed by `/` and its
   depth is less than the greatest depth of all. (The root path `""` has every
   other path below it.) That is `drops_shallower`; an error that has one below
   it and is as deep as the deepest is kept (`keeps_at_max_depth`), which is
   what the extra level of `additionalProperties` (`additional_depth`) decides
   in the cases that show it.
4. The message and path: `additionalProperties` writes the path
   `instancePath + "/" + token(additionalProperty)` (`~` is `~0`, `/` is `~1`) and
   `Unknown field "<name>". The IR schema is closed; unknown fields are
   rejected, not ignored.`; `required`, `Missing required field "<name>".`;
   `const` and `enum`, `Value must be one of <JSON of each allowed value,
   joined by ", ">.`; `pattern`, `Value does not match <pattern> (names are
   ASCII identifiers).`; `discriminator`, `Unknown or missing tag: <Ajv's
   message>.`; every other keyword, `Schema violation: <Ajv's message>.`.
5. An error whose `path|message` was already given is dropped
   (`removes_duplicates`), the first in the visiting order staying.
6. The diagnostics are sorted by `at.path`, by UTF-16 code units, stably
   (`same_path_order`: equal paths keep the order of step 3; the cases
   `sort_not_code_point` and `sort_not_locale` are those in which that order
   differs from a code point order and from a case-insensitive one).
   `at.span` is the span of the nearest path that has one (the path itself for
   an unknown member is that of its value).
7. Each is E0104 with `facts: { keyword, schema_path: e.schemaPath }`.

Version gates (below) add their E0104 after these, and E0105 for the number of
definitions; the schema is not consulted (and these are all the diagnostics)
for a document that is not an object or has no known language.

### What Ajv does that a port must copy

The validator is `new Ajv2020({ allErrors: true, discriminator: true, strict:
true, strictRequired: false })` (Ajv 8.20.0; draft 2020-12; no formats; no
coercion, defaults or `verbose`) compiled from `spec/ir.schema.json`; the one
of the lock is `new Ajv2020({ allErrors: true, strict: true })` from
`spec/lock.schema.json`. `irSchemaErrors` (`compiler/src/ir/validate.ts`) and
`lockSchemaErrors` (`compiler/src/lock.ts`) return the errors of those same
instances, and exist for these vectors. The value is the one the strict reader
builds: a JS object with no prototype, so a member named `__proto__` is a name
like any other, and the names that are array indices (`"2"`, `"10"`) are visited
first in numeric order, then the others in the order written.

- **Order of evaluation of one schema**, from `ajv.RULES`: (1) `type`, when it is
  `integer`, `boolean` or `null`, at once; (2) `const`, `enum`, `not`, `anyOf`,
  `oneOf`, `allOf`, `if`; (3) for a number `maximum`, `minimum`; (4) for a
  string `maxLength`, `minLength`, `pattern`; (5) for an array `maxItems`,
  `minItems`, `items` (index order), then `uniqueItems`; (6) for an object
  `maxProperties`, `minProperties`, `required` (one error for each missing
  name, in the order of the `required` list), `propertyNames` (for each name in
  the visiting order of the document, the errors of its subschema, then one
  `propertyNames` error), `additionalProperties` (one error for each name
  that is not in `properties`, in the visiting order of the document),
  `properties` (in the order of the schema's `properties`), `discriminator`.
  A keyword of a group is skipped when the value is not of the group's type,
  and then the `type` error of a schema of one type is given at the end of
  that group (`string`, `array`, `object`, `number`). (This is from Ajv's
  code: no schema here has a keyword of group (2) beside a `type` of a group,
  so no vector shows where that `type` error falls among them.)
- **`oneOf` without a discriminator** (`TypeExpr`, `TemplatePart`, `Verifier`,
  `ReadSource.query`): the errors of branch 0, 1, … in order (their
  `schemaPath` is `#/oneOf/<i>/…`), then one `oneOf` error with `params:
  { passingSchemas: null }`. The branches are closed and tell themselves
  apart by a required member, so no value passes two.
- **A discriminator** (`Def` by `kind`, `Expr` and `Stmt` by `op`, `Pattern` by
  `p`, `Tier` by `by`): the `oneOf` keyword is not run. The branch whose tag
  member is the value is run and its errors are written `#/oneOf/<i>/…`. When the
  tag is not a string the error has `params: { error: "tag", tag: "<name>",
  tagValue: <the value> }` (`tagValue` is left out when the member is missing,
  so a missing tag gives a `required` error and then a `discriminator` error);
  when no branch has the value, `params: { error: "mapping", tag, tagValue }`.
  Messages: `tag "<name>" must be string`, `value of tag "<name>" must be in
  oneOf`. A value that is not an object gives only the `type` error.
- **`schemaPath`**: Ajv inlines a `$ref` whose target has no `$ref` in it (here
  `Name`, `QName`, `Money`, `Command`, `Tier` in the IR schema; `Version`,
  `Level`, `DataClass` in the lock schema) and then writes `#/$defs/<Name>/…`
  for its keywords. For any other `$ref` the path starts again at `#` at the
  root of the target, so it never names the definition (`#/oneOf/3/required`, `#/type`,
  `#/required`). A property is `…/properties/<name>/…`, a map's values
  `…/additionalProperties/…`, array items `…/items/…`.
- **`params` and `message`** (the `message` is Ajv's own): `type`: `{ type }`,
  `must be <type>`; `required`: `{ missingProperty }`, `must have required
  property '<name>'`; `additionalProperties`: `{ additionalProperty }`, `must
  NOT have additional properties`; `enum`: `{ allowedValues }`, `must be equal
  to one of the allowed values`; `const`: `{ allowedValue }`, `must be equal to
  constant`; `pattern`: `{ pattern }`, `must match pattern "<pattern>"`;
  `minimum`, `maximum`: `{ comparison: ">=" or "<=", limit }`, `must be >= <n>`,
  `must be <= <n>`; `minLength`, `maxLength`: `{ limit }`, `must NOT have fewer
  than <n> characters`, `must NOT have more than <n> characters`; `minItems`:
  `{ limit }`, `must NOT have fewer than <n> items`; `uniqueItems`: `{ i, j }`
  with `j` the earlier index, `must NOT have duplicate items (items ## <j> and
  <i> are identical)`; `minProperties`: `{ limit }`, `must NOT have fewer than
  <n> properties`; `propertyNames`: `{ propertyName }`, `property name must be
  valid`; `oneOf`: `{ passingSchemas: null }`, `must match exactly one schema in
  oneOf`; `discriminator`: as above. The errors raised inside a `propertyNames`
  subschema carry `propertyName` too (the name that failed).
- **A keyword that applies to one kind of value is not run on another**: a
  `pattern` on a number, a `minimum` on a string, an `items` on an object. The
  `type` error alone is given.

### ir-gates.json

`{ "format": "mandate/vectors/schema/ir-gates/0.1", "cases": [ … ] }`: the
checks of `validateIr` that are not the schema. A case: `name`, `rule` (`<table>.<key>`
for a row of the `SINCE` tables of `compiler/src/ir/validate.ts`, else the name
of the rule), `since` (the language that introduced the construct, else
`null`), `language`, `verdict` (`accepted`: `diagnostics` is empty; `refused`: all
E0104), `input` (a small program, pretty-printed) and `diagnostics`. For each row
of each table the program is accepted in the newest language and in `since`,
and refused in each language before `since`; the test derives the cases from
the tables themselves, so a new row without a program fails it. Also the five
places a budget is written (`budget.agents` under a workflow, an agent, a skill, a
delegation and an envelope), `progress.repeats` over `progress.window`, and the
negative `int`, `dec` (also `-0.0`) and `money` literal, refused only from 0.5
and found anywhere in an expression.

### lock-invalid.json

`{ "format": "mandate/vectors/schema/lock-invalid/0.1", "cases": [ … ] }`. The entry point
is `validateLock(value)`, where `value` is what the strict reader reads `input`
to: the same call that `check` makes (after the program checks) and the CLI
makes of a lock file. A lock gives no spans: `at` is `{ path }`. A case:
`name`, `base` (a lock of the repository: `fixtures/boundary/reach.lock.json`,
`conformance/E1802c/mandate.lock.json`, `conformance/E1502/mandate.lock.json`,
`fixtures/fixbug/mandate.lock.json`), `pretty`, `input`, `raw_errors` (empty for
a lock the schema accepts) and `diagnostics`. For a raw error the diagnostic is
E0140 `The lock file does not match spec/lock.schema.json: <instancePath or "/"> <Ajv's message>`
(no sorting, no dropping, no deduplication; `at.path` is the `instancePath`,
`facts: { keyword, params }`). For a lock the schema accepts, the last
cases give E0140 for the format a field needs (`bindings` 0.3, `members` and
`roles` 0.4, `host`, `isolation` and `egress` 0.5), a key under two members, a
role that lists a member that is not in `members`, and a tier whose model has
no tariff, in that order.

## The golden output texts (`MANDATE_GOLDEN_OUT`)

The golden file (`compiler/test/golden/outputs.json`) pins the output texts of
24 programs by digest. When the environment variable `MANDATE_GOLDEN_OUT`
names a directory, `compiler/test/golden.test.ts` also writes every text to
`<dir>/<program path>/<output file name>`, for a job to compare with another
compiler's texts by `diff -ru`: `<program path>` is the repository path of the
program (`fixtures/fixbug/fixbug.mdt`, a directory for each program), and the
output file name is the output's name with each space replaced by `_`:
`check`, `check_--module`, `check_--lock`, `load`, `ir_--canonical`, `fmt`,
`hash`, `view_--format_json`, `view_--format_md`, `view_--format_html`,
`view_--against_itself`, `sandbox` (231 files; a program has only the outputs
the golden file pins for it). The bytes are exactly those that are hashed (UTF-8,
no newline added), and the directory is created. Nothing is written when the
variable is not set, and nothing of these texts is committed. The Rust side
writes the same layout. The texts come from `compiler/test/golden-outputs.ts`.

## diagnostics/

The whole result of the compiler for the inputs the repository already has: every
conformance case that runs a compiler, and the checks of every golden program. A
conformance case today states only codes and paths; these files state the rest
(`ok`, `hashes`, and for each diagnostic its `severity`, `message`, `at` with
`span`, `docs`, `facts` and `repair`, every member in the compiler's order, the
diagnostics in the compiler's order). They are written by
`compiler/test/diagnostic-vectors.test.ts`, which fails when a file differs from
what the compiler gives now; the same command (`MANDATE_UPDATE_VECTORS=1 npm
test`) writes them again. The files are within the limits of the reader (ASCII,
each under 900 KB and split into numbered parts when a file would pass 800 KB,
nesting up to 64, integers only, no duplicate key, no lone surrogate); the test
asserts all of it. The inputs are not copied: a vector names them, and the Rust
test reads the same files of `conformance/` and `fixtures/`.

A result is a value in the compiler's member order, not text. The exception is a
result that holds a number that is not an integer (a cost, a ratio), which JSON
integers cannot carry: it is stored as its exact text under `text` (a vector) or
in `texts` (a program) instead. No result today holds such a number, so no vector
uses `text`; the members stay in the format for a compiler that gives one.

### conformance-N.json

`{ "format": "mandate/vectors/diagnostics/conformance/0.1", "part": N, "parts":
M, "cases": [ … ] }`. The cases are in one order across the parts, by `name` in
UTF-16 order. There is one vector for every `compile` case of `conformance/`
(125; the 16 `journal` cases are about the runtime's verifier and have none).
A case:

- `name`: the case's `id`, which is its directory `conformance/<name>/`;
- `kind`: `"compile"`;
- `door`: which function of the compiler the case goes through (below);
- `input`: `{ "file", "kind" }`, the case's own `input` (a path relative to the
  case directory, `kind` `mdt` or `json`), or `{ "inline": true, "kind" }` when the
  source is the `input.text` of `case.json`;
- `modules`: the case's `modules`, paths relative to the case directory, in order
  (empty when it has none);
- `lock`: the case's `lock` path, or `null`;
- `uses`: which of `patch`, `base`, `subprogram` and `amendment` of `case.json`
  feed the door, in that order (the vector does not copy them);
- `result`: what the door returns, as below. Or `text` in its place (above).

The doors, with what they are called with and what each result holds:

- `check`: `check(input, kind, { modules, lock })`. `modules` are loaded together
  with `loadModules` (each against the others; they must load), `lock` is the
  parsed lock file. Result `{ ok, hashes?, diagnostics }`: `hashes` (`{ program,
  defs }`) only when `ok`. (The IR and the spans a check also returns are not
  stored.)
- `check_patched` (`uses: ["patch"]`): the input is loaded and must load without
  errors; the case's RFC 6902 `patch` (`add`, `replace`, `remove`) is applied to its
  IR and the patched IR, as JSON text, is checked as `check` with `kind` `json`
  (so spans are those of that text). Result as `check`.
- `apply_ops` (`uses: ["patch", "base"]`): the input is loaded as above;
  `applyOps(program, base, patch)` is called. If it gives no program the result is
  `{ ok: false, diagnostics }` with one diagnostic (E0130 for a stale `base`,
  E0131 for an operation that cannot be applied); otherwise the program is
  written as JSON text and checked as `check_patched`. Result as `check` where
  the patched program was checked.
- `check_subprogram` (`uses: ["subprogram"]`): the input (with `modules`) is the
  parent, which must check without errors. `checkSubprogram` is given the parent,
  the modules, `workflow`, `number` (1 if not given), `base` (the program hash of the
  skeleton `<parent module>.plan_<number>`), `ops` (one `add` at `/defs/<name>`
  for each definition of the `defs` module, in order, then the case's `patch`),
  `lead` (`public` if not given) and `room` (`left`, `time_left_ms`, `writes`, each
  write with its capability constructor's effect). Result `{ ok, diagnostics,
  program?, hash?, workflow? }`: the last three only when `ok`.
- `check_amendment` (`uses: ["amendment"]`): the input is the run's program, which
  must check without errors; the new envelope is the envelope of the case's
  workflow with the case's patch applied. `checkAmendment` returns `{ ok,
  diagnostics, program?, hash? }`; `program` and `hash` only when `ok`. The case's
  `hashes.program` is `hash`.

`kind` is `compile` for all: a `run` case would fail the compiler's test run, and
there is none today.

The test asserts, for every case, that the stored result satisfies the case's own
`expect` under the rule of `conformance/README.md` (`ok`; the diagnostics one to
one by code and path, facts as a subset; `hashes`), and that the files and paths a
vector names exist.

### golden-N.json

`{ "format": "mandate/vectors/diagnostics/golden/0.1", "part": N, "parts": M,
"programs": [ … ] }`, one vector for each program of `compiler/test/golden/outputs.json`
(21), by `program` in UTF-16 order. A program:

- `program`: its repository path;
- `modules`: the module files it is given (repository paths, in the order they are
  loaded together with `loadModules`): `fixtures/system/acme.system.mdt` and
  `fixtures/system/repos.mdt`, except `fixtures/envelope/migrate-all.mdt`, which is
  given `fixtures/envelope/domain.mdt` only;
- `lock`: the lock it is checked with (repository path), or `null`: `<name>.lock.json`
  beside the program when that exists, else `mandate.lock.json` beside it;
- `results`: members `check` (`check(program, kind)`, no modules, no lock),
  `check_module` (`{ modules }`), `check_lock` (`{ modules, lock }`, only where `lock`
  is not `null`) and `load` (`load(program, kind)`). Each of the first three is `{
  ok, hashes?, diagnostics }`, the value of the golden output of the same name
  (`check`, `check --module`, `check --lock`); `load` is the array of diagnostics
  alone (output `load`). The kind is `json` for a file ending `.json`, else `mdt`;
- `texts`: `{}`, or, for a result with a number that is not an integer, that
  result's name with its exact text. A name is then in `texts` and not in `results`.

The text the golden test hashes for each of the four outputs is exactly the
pretty form of the stored value (`JSON.stringify(value, null, 2)` and a newline),
so its sha256 is the digest in the golden file; the test asserts it.

### summary.json

`{ format, conformance_cases, conformance_by_door, golden_results, diagnostics,
by_code, codes_in_no_result }`: the counts the test asserts. `conformance_by_door`
counts the cases by door; `golden_results` the stored results of the golden
programs; `diagnostics` every diagnostic of every stored result (a diagnostic
that a `check` and a `check_module` both give is counted twice); `by_code` the
diagnostics by code, for the codes that occur; `codes_in_no_result` the codes of
`compiler/src/codes.ts` that occur in no stored result.

## Reading Mandate text: syntax.json and spans/

These pin what the lexer and the parser (`compiler/src/parse/`) give, for
the Rust port to match: the IR with its member order, the table that maps
each JSON Pointer of the IR to the span of text it came from, every
diagnostic in full, and the text `fmt` prints. They are written by
`compiler/test/syntax-vectors.test.ts` (the inputs are in
`compiler/test/syntax-cases/`), which also asserts what they cover: every
message the lexer and the parser can give, every construct of the IR and
each optional part of it (read from `spec/ir.schema.json`), every literal
and token form. A message that no input can reach is listed in the test with
the reason; there are five, each a check that cannot fail because the parser
has already seen what it asks for.

### syntax.json

`{ "format": "mandate/vectors/syntax/0.1", "vectors": [ … ] }`. Each vector
is what `load(text, "mdt")` (`compiler/src/check.ts`) gives for one text: the
parser, then the validation of the IR it builds against the schema. Fields,
in the order the file lists them:

- `name`: starts with the section the input belongs to; unique.
- the input, exactly one of `input` (the text; line breaks and carriage
  returns are in the JSON string as escapes, so what the file holds is what
  the reader is given) or `input_parts` (`[[text, count], …]`, each text
  repeated `count` times and joined, as in `reader.json`, for the few inputs
  too large to write out; the size limit counts the UTF-8 bytes of the joined
  text).
- `ok`: true when `load` gave a program and no diagnostic has severity
  `error`.
- `diagnostics`: every diagnostic `load` gave, in order, each with all its
  fields (`code`, `severity`, `message`, `at` with `span` and/or `path`,
  `docs`, `facts`, `repair`; only those the compiler sets). In order: first
  what the parser pushed while it read on (`MDT-E0103`, `MDT-E0121`, in the
  order they were found, then `MDT-E0120` for each handler without a
  workflow), then those of the schema validation. When the parser stops, the
  only diagnostic is the one that stopped it (see below). Spans are
  `[startLine, startCol, endLine, endCol]`, 1-based, end exclusive.
- when `load` gave a program (a vector can be `ok: false` and have one: the
  parser's own diagnostics and the schema's do not take the program away):
  - `canonical`: the canonical text of the IR, or, when it is longer than
    1500 characters, `canonical_sha256`, the hex SHA-256 of its UTF-8;
  - `ir`: the IR in the parser's member order, as `load` gives it (a
    JSON round trip of what the parser built, so no null-prototype objects).
    Left out when the canonical text is given by its digest or the IR is
    nested more than 61 deep (the reader refuses nesting over 64 and the IR
    sits three levels down in this file); then `ir_depth` is its depth, the
    way the strict reader counts it (the root is 1);
  - `spans`: the pointer-to-span table as `[pointer, startLine, startCol,
    endLine, endCol]` rows, one per entry, by pointer in UTF-16 code-unit
    order; or, when the rows written as compact JSON, one per line, come to
    more than 1500 characters, `spans_count` and `spans_sha256`: the hex
    SHA-256 of those rows written as `["/p",1,2,3,4]` (no spaces), joined
    with a line feed, no final one;
- when also `ok`: `fmt`, what `printProgram` prints for the IR (`mandate
  fmt`), and `fmt_roundtrip`: `true` when that text reads back with no error,
  to the same canonical IR, and printing that IR gives the same text again;
  otherwise `{ reads, same_ir, stable }` (three booleans) with `diagnostics`
  of the reading when it failed. If printing throws: `fmt_error`, the
  message. Four vectors do not round trip (a comparison in parentheses on
  the left of a comparison: the printer writes it without them); no vector
  has `fmt_error`. They record what the reference does; nothing was fixed.

A vector with no `canonical` and no `canonical_sha256` is one the parser
refused: `load` gave no program and an empty span table.

The TypeScript lexer quotes the character it did not expect as one UTF-16
code unit. For a character outside the Basic Multilingual Plane in code, that
is half of a pair, so its message holds a lone surrogate, which no vector can
carry. There is no such vector. The Rust lexer writes U+FFFD there.

### spans/

One file per program in `programs/`, named like it (the JSON program, `fixbug.ir.json`,
has one too, from the strict JSON reader): `{ format:
"mandate/vectors/spans/0.1", source, kind, count, spans }`, `spans` being
the rows described above, `count` their number. Every table is in full (the
largest, `fixbug.ir.json`, is 64 KB; the files come to 194 KB). Nothing reads
the table in insertion order: every phase looks a pointer up, and
`nearestSpan` goes up to the parent pointer when there is no entry, so the
order of rows is only sorted for the file.

### What an implementation has to copy

Spans.

- A span runs from the first character of the node's first token to just
  after the last character of the last token the parser consumed for it.
  Lines break at line feed only; a carriage return, a tab and every UTF-16
  code unit are one column each (a character outside the BMP is two). The end
  of input is a token of no width, at the position after the last character.
- Only the objects the parser builds have an entry; arrays and maps (`defs`,
  `tests`, `params`, `args`, `body`, `caps`, `effects`, `items`, `parts`,
  `cases`, `fields`, `branches`, `members`, `skills`, `reads`, `authorize`,
  `approve`, `handlers`, `order`, `changes`, `uses`) and scalars have none,
  nor do the wrappers `{ "text" }` and `{ "expr" }` of a template part (the
  `expr` inside has one), `progress`, `spawn`, a `command`, a tier, and the
  `all` of a verifier. Diagnostics later look a pointer up and take the
  nearest entry above it.
- The program starts at its first token (the `mandate` of a language line, or
  `module`; comments before it do not count) and ends at the last token of the
  file. A definition starts at its first token (`pub`, `role`, `agent`, `test`,
  …) and ends at its last. A handler (`on e in W => x`) is `/defs/W/on/N`
  and starts at `on`.
- Where a node starts is not always its first keyword: a parameter, a skill,
  a read, a changeset member, a type's variant and a named argument start at
  their name; a criterion at `accept` or `invariant`; a `budget`, `envelope`
  and `on unmet` at their word; a remote binding at the expression it binds.
- A parenthesised expression has the span of what is inside, without the
  parentheses; the operation or call it is part of starts at the parenthesis.
  A chain `a + b + c`, `a.b(c)?` is left associative and every node of it
  starts at the first token of the whole chain. A prefix operator
  (`not`, `-`) starts at itself.
- A node marked twice keeps the last span. Arrays that are sorted (`caps`,
  `effects`, `requires_caps`, `uses`, `names`, `provides`, `consumes`,
  `governance`) are sorted before the table is made: an entry's pointer
  carries the index the node has in the sorted array.
- Inside an interpolation, positions are real positions in the file: the
  nested lexer starts at the character after `{`, columns go on, and a line
  break inside (which a single-line string allows there) counts.

Member order.

- The IR is built in the order the code assigns, not always in source order.
  `program`: `language`, `module`, `version`, `defs`, then `uses`, then
  `tests`. `const`: `kind`, `value`, then `type`. `type`: `kind`, `type`,
  `generics`, `class`. `fn`: `kind`, `params`, `returns`, `body`, then `pub`,
  `effects`, `budget`. `extern`: `kind`, `lang`, `file`, `symbol`, `params`,
  `returns`, `effects`, `idempotent_by`. `effect`: `kind`, `params`,
  `returns`, then its options in source order (`requires_caps` at the first
  one). `agent`: `kind`, `caps`, `skills`, then `role`, `model`, `budget`,
  `loop`, `progress` in source order, or `remote` for a remote agent (its
  keys: `bind`, then `version`, `require`, `trust` in source order). `skill`: `params`, `returns`, `effects`,
  `budget`, `body`. `workflow`: `kind`, `params`, `returns`, `caps`, `body`,
  then `budget`, `envelope`, `ensures`, and last `on`. `contract`: `kind`,
  `params`, `accept`, then `require` and `invariant` where first seen.
  `component`: the four required fields first, then the others in source
  order; `environment`: `kind`, `class`, then `reads` and `authorize` where
  first seen. `test`: `body` first, then `handlers`, though `handlers` come
  first in the text. `par`: `branches`, then `supervise`, though `supervise`
  comes first. `let`: `name`, `value`, then `type`. `loop`: `body`, then
  `max_iter` or `until`. `delegate`: `agent`, `skill`, `args`, then its
  options in source order; `map`: `bind`, `over`, `body`, then options in
  source order; `changeset`: `plan`, `members`, `order`, `approver`, then
  `changes` where first seen and `idempotent_by`; `infer`: `type`, `from`,
  `using`; `verify`: `value`, `contract`, `args`, `on_unmet`; `effect`:
  `name`, `args`, `idempotent_by`, `compensate`. A `budget`, `envelope`,
  `spawn` or `progress` has its keys in source order.
- A map (`defs`, `fields`, `branches`, `tests`, …) lists its keys in order of
  first appearance; a repeated key keeps its first place and takes the last
  value. A JavaScript object lists integer-like keys first, ascending: the
  one map whose keys are free text, `tests`, shows it (`"9"`, `"10"`, then
  the rest), and so does `fmt`, which follows it.

Numbers and strings.

- Digits may have `_` between them (not in a fraction). A `.` belongs to a
  number only when a digit follows it. An integer or the whole part is read
  as a base-10 number and must be at most 2^53-1. A suffix is the run of
  letters after the number: `k`, `M` give an integer; `ms`, `s`, `m`, `h`,
  `d` a duration in milliseconds; a fraction is allowed when the result is a
  whole number of base units (exact arithmetic); any other run of letters is
  an unknown suffix (`20USD`, `1e3`, `0x10`). A decimal keeps its text
  (leading and trailing zeros), without `_`.
- `-1` is `unary neg` of `1`; there are no negative literals.
- An integer or decimal followed by an identifier of exactly three capital
  letters, on any line, is money: micro-units are the whole part times a
  million (or the digits with the fraction padded to six places); more than
  six places, or past 2^53-1, is an error at the number.
- The escapes are `\n \t \r \" \\ \{ \}`; anything else is an error at the
  character after it. A string with no interpolation is `text` (an empty one
  too); otherwise `template` with `parts` (text pieces joined, empty ones
  left out); `prompt"…"` is always `prompt`. A single-line string may not
  hold a line feed, a `"""` string may.
- An interpolation is the raw text between `{` and the matching `}` (braces
  counted, a `"` inside is an error), read by a new lexer and parser: their
  nesting count starts at 0, and `budget` messages name the 0.1 fields
  whatever the file's version. Words inside it that follow the expression are
  an error ("Unexpected … in interpolation").

Errors and limits.

- The parser stops at the first error it cannot read past, and the diagnostics
  it had pushed (`E0103`, `E0121`, `E0120`) are lost with it. The lexer runs
  over the whole file before the parser starts, so a lexical error anywhere
  is the one reported, even when a syntax error comes before it. A string's
  interpolation is read only when the parser reaches the string.
- A lexical error spans one column at the offending character (a number or
  string error at its first character; an invalid escape after the escape
  letter; an unterminated interpolation just after `{`). A syntax error
  spans the token the parser is at, or an earlier token the message names.
- Input over 1048576 UTF-8 bytes: `MDT-E0105`, no `at`. Text nested 64 deep
  (parentheses, blocks, types, patterns, operands of `not` and `-`): `MDT-E0105`
  at the token. After parsing, the first value in canonical order nested more
  than 64 deep in the IR: `MDT-E0105` with its `path` and the nearest span.

Printing: `fmt` sorts definitions by kind and name, writes two-space
indents, and drops comments; the vectors give the text, and the four that do
not read back.

## diff/

What the views that compare two things give, when something did change. The golden
file pins only `view --against` a program with itself, which shows no change; these
files hold, for 183 pairs of programs (and of locks), the result of every comparing
function the CLI or the runtime reaches, for the Rust port of those views to match
member for member and, for the documents, character for character. They are written
by `compiler/test/diff-vectors.test.ts` (the written pairs are in
`compiler/test/diff-pairs.ts`), which fails when a file differs from what the compiler
gives now; `MANDATE_UPDATE_VECTORS=1 npm test` writes them again, and
`MANDATE_VECTORS_REPORT=1` also prints the coverage table. The files are ASCII, each
under 900 KB (split into numbered parts of at most about 700 KB), nesting up to 64,
integers only, no duplicate key, no lone surrogate, and about 1.1 MB in all; the test
asserts it. The inputs that exist are not copied: a vector names them, and the Rust
test reads the same files of `conformance/`, `fixtures/` and `compiler/test/fixtures/`.
Only the written pairs carry program text.

### The comparing functions

All are in `compiler/src/views/views.ts` (the HTML and the Markdown in `views/doc.ts`).
Programs are the checked IR (`Program`); a `Lock` is the parsed lock file.

- `semanticDiff(before, after, locks?)` returns the `DiffView` `{ format, kind: "diff",
  from, to, governance, behavior, unchanged }`: `from` and `to` are `{ module, version,
  language, hash }` (`programRef`), `governance` and `behavior` are lists of `{ path,
  text }`, `unchanged` a list of strings. `locks` is `{ before?, after? }`. It takes no
  modules: it compares the programs as they are. Reached by `mandate view <file>
  --against <old file>` (`--format json` prints `JSON.stringify(view, null, 2)` and a
  newline; the locks are the lock files next to the two files, as `readLock` finds them;
  both programs are checked, the new one with its lock, with the `--module` files);
  by the MCP tool `mandate.project` with `view: "diff"` (no locks); by the runtime in
  `runtime/src/package.ts` (`checkAmended`: `diff` of an amendment) and in
  `runtime/src/views.ts` (the authority of a change set: the `text` of each governance
  change of a Mandate file the set lands).
- `diffDoc(before, after, locks?)` returns the `Doc` of that view: title, three meta
  lines and `diffBlocks(view)`. `toMarkdown(doc)` and `toHtml(doc)` (`doc.ts`) render it.
  Reached by `mandate view <file> --against <old file>` with `--format md` (the default)
  or `--format html`.
- `lockDiff(before?, after?)` returns a list of `{ path, text }`: the members and the
  role holders two locks bind. `lockLimitsDiff(before?, after?)` returns `{ governance,
  behavior }`, two such lists: what two locks of format 0.5 ask of the host and of the
  sandboxes. Both are only called by `semanticDiff` (when `locks` is given); they are
  exported, and the runtime does not call them.
- `governanceChanges(before, after, modules)` returns a list of `{ kind, path, text }`:
  the governance changes of the program, each with its kind (`capability_added`,
  `budget_increased`, `criterion_removed`, `criterion_changed`, `require_changed`,
  `irreversible_added`, `system_model_changed`, `envelope_changed`,
  `remote_agent_added`, `remote_binding_changed`, `kind_changed`). It is what
  `semanticDiff` shows as `governance`, less the locks', but it is given `modules`
  and opens a capability over a component or an environment into what it stands for.
  Reached by `mandate patch <file> <patch>` and the MCP tool `mandate.apply_patch`
  (`applyPatch`, after the patch is applied to the program as loaded, with the
  `--module` files), and by the runtime in `runtime/src/plan.ts` (the kinds of a
  sub-program).
- `envelopeChanges(before, after, workflow, modules)` returns a list of `{ path, text }`:
  what changed in one workflow's envelope, line by line. Reached only by the runtime
  (`runtime/src/package.ts`, `checkAmended`, for the amendment of an envelope); the CLI
  does not call it. Nothing, when the workflow has no envelope on one side.

There is no other function that takes two of something. (`checkAmendment` compares an
envelope with its amendment but returns diagnostics, in `diagnostics/`;
`governanceFiles` takes the files of one change and is not a comparison.) Every function
above is exercised by the vectors; `lockDiff` and `lockLimitsDiff` only in the cases that
give a lock.

### cases-N.json

`{ "format": "mandate/vectors/diff/cases/0.1", "part": N, "parts": M, "cases": [ … ] }`.
The cases are in one order across the parts: the conformance patches, the conformance
amendments, the repository pairs, the lock pairs and the written pairs, each group in
the order the test builds it (by `name` in UTF-16 order for the conformance cases; the
order of `compiler/test/diff-pairs.ts` for the written ones). A case:

- `name`: unique. A conformance case's id; a repository pair's name; for a lock pair
  `<before lock path> -> <after lock path>`; a written pair's name.
- `source`: `conformance_patch`, `conformance_amendment`, `repository`, `lock`
  or `written`.
- `note`: one sentence about the pair.
- `before`, `after`: where each program is (below).
- `modules`: repository paths of the modules (`loadModules`, all together, each
  checked against the others) the programs are checked with, `[]` for none. They are
  also what `governanceChanges` and `envelopeChanges` are given as `modules`;
  `semanticDiff` is given none.
- `locks`: `{ "before", "after" }`, each `null` or `{ "file" }` (a repository path) or
  `{ "text" }` (the text of a lock file). If both are `null`, `semanticDiff` and
  `diffDoc` are called without `locks`, and the case has no `lock_diff` and no
  `lock_limits_diff`. Otherwise `locks` is `{ before?, after? }` with the parsed lock
  of each side that has one (a missing member is a missing lock).
- `results`, `texts`: the value of each result, as the compiler gives it (below);
  `texts` holds a result with a number that is not an integer as its exact text
  (`JSON.stringify(value, null, 2)` and a newline) under the same name, and the name is
  then not in `results`. This is the exception that `diagnostics/` has; no case uses it
  today (`cases_with_other_numbers` in `summary.json` is empty): a change shows an amount
  as text (`0.5 USD`, `20m`), never as a number.
- `markdown`: `toMarkdown(diffDoc(before, after, locks))`, whole.
- `html_sha256`, `html_length`: the lowercase hex SHA-256 of the UTF-8 of
  `toHtml(diffDoc(before, after, locks))`, and its length in UTF-16 code units.
- `html`: that text, whole, only for the cases of `conformance_patch`,
  `conformance_amendment` and `repository`, and for 14 written pairs (`spares-added`,
  `spares-removed`, `kind-changed`, `cap-host-and-methods-widened`,
  `agent-budget-raised`, `contract-criterion-removed`, `envelope-all-at-once`,
  `envelope-added`, `system-component-fields-changed`, `linked-capabilities-widened`,
  `lock-member-added`, `lock-limits-all-at-once`, `lock-absent-before`,
  `special-characters`). Every other case has only the digest: the page around the
  table is the same, and the pairs above show every kind of block and every escape.

A side is one of:

- `{ "file", "kind" }`: the program in that repository file, `kind` `mdt` or `json`.
- `{ "text", "kind" }`: the program in that text (the written pairs).
- `{ "file", "kind", "patch_of": "<id>" }` (only `after`, of `conformance_patch`): the
  program of `file` after the patch of `conformance/<id>/case.json` is applied, as the
  case's front door does (the case's `base` makes it `applyOps`; without one, an RFC
  6902 patch of the loaded IR) and the patched IR is checked. `before` of the case is
  the same `file` as loaded: it need not check (a patch may be what makes it check),
  and the Rust side loads it as it loads the base of the case in `diagnostics/`.
- `{ "file", "kind", "amend_of": "<id>" }` (only `after`, of `conformance_amendment`):
  the program of `file` (which checks, with `modules`) with the envelope of the case's
  `amendment.workflow` replaced by the case's envelope (that workflow's envelope with the
  case's `amendment.patch` applied), the whole checked as JSON text. The amended program
  checks in all five cases, though the amendment of `E1709*` narrows an envelope and is
  refused by `checkAmendment`; the vectors still compare the two programs.

The programs are checked with `check(text, kind, { modules })` and must have no error
(the base of a `conformance_patch` only loads). No lock is given to `check`: the locks
are inputs of the comparing functions only.

`results` has these members, in this order:

- `diff`: `semanticDiff(before, after, locks)`, the `DiffView`.
- `governance_changes`: `governanceChanges(before, after, modules)`.
- `envelope_changes`: a list `{ "workflow", "changes" }`, one for every workflow that
  both programs define, by name in UTF-16 order, `changes` being `envelopeChanges(before,
  after, workflow, modules)` (empty when a workflow has no envelope on one side, or no
  change).
- `lock_diff`, `lock_limits_diff`: `lockDiff(locks.before, locks.after)` and
  `lockLimitsDiff(locks.before, locks.after)`, only where a lock is given.

Every result is a value in the compiler's member order (`DiffView`: `format`, `kind`,
`from`, `to`, `governance`, `behavior`, `unchanged`; `from` and `to`: `module`, `version`,
`language`, `hash`; a change: `path`, `text`; a kinded change: `kind`, `path`, `text`).
Lists are in the order the compiler gives them, which the port must copy (below).

### The pairs, by source

- `conformance_patch` (7): the cases that patch a program and whose patched program
  checks: `E1801d`, `E1801e`, `E1804a`, `S12b`, `V02b`, `V03c`, `V04b`. The other 33
  patch cases (of 40: 36 `check_patched`, 4 `apply_ops`) refuse the patched program on
  purpose and are left out (`conformance_cases_left_out` in `summary.json`).
- `conformance_amendment` (5): `E1709`, `E1709a`, `E1709b`, `E1709c`, `N04`, the
  program of `conformance/N01/parent.mdt` and the same with the amended envelope.
- `repository` (5): `fixtures/fixbug/fixbug.mdt` and `fixtures/fixbug-target/fixbug.mdt`
  (versions of one program: both ways); the `.mdt` and the `.ir.json` of the first (the
  same program: no change); `fixtures/system/land.mdt` and `loosen-ci.mdt` (the second
  is the variant of the first that loosens a component's CI: both ways, with the
  system model as `modules`). The locks next to the files are given. The other programs
  of `fixtures/` are not versions of one another.
- `lock` (19): each lock file of the repository against itself (the program it goes
  with is both sides: `fetch.mdt` for `fixtures/boundary/mandate.lock.json` and the
  `E1802*` and `E1803` locks, `reach.mdt`, the two `fixbug` programs and `migrate-all.mdt`
  with `fixtures/envelope/domain.mdt` for `E1502`), and the fixture's own lock of
  `fetch.mdt` against each other lock of the same program that differs (both ways).
- `written` (147): pairs for what those do not reach, from `compiler/test/diff-pairs.ts`:
  small programs and their changed versions, and locks with them. A written pair stores
  its texts; `kind` is `mdt`; locks are `{ "text" }`. No lock holds a value that looks
  like a key: credentials are named `MADE_UP…`.

### summary.json

`{ format, cases, by_source, cases_with_other_numbers, conformance_cases_left_out,
coverage }`. `coverage` lists, for each kind of change the code can report, `{ kind,
section, cases, first_case }` (plus `unreachable` and a reason for the kinds no input
reaches). `section` is where the change is read: `G` the `diff`'s `governance` (and
`governance_changes`), `B` its `behavior`, `E` `envelope_changes`, `K` the kinds in
`governance_changes`, `U` the `unchanged` lines. The test fails when a kind that is not
marked `unreachable` has no case, when one marked `unreachable` has one, and when a
change in the stored outputs belongs to no kind. The kinds are made from the code's own
lists where it has them (the definition kinds, the budget dimensions, the data classes
and `GovernanceChangeKind`, which the test reads from the source) and written by hand
for each text the code builds.

### What a port must copy

The order of a list is part of the result.

- `semanticDiff`: the definitions of both programs by name in UTF-16 order (uppercase
  before lowercase, `PR` before `Patch`), and for each its changes in the order of the
  code: the definition's kind, then by kind. A capability: the scopes (paired by
  constructor, and for `exec` by its command list), then added, other, removed; added
  and other are governance, removed is behavior (`… (narrowed)`); a capability whose
  scopes show nothing but whose definition changed is `~ capability N changed`. An agent
  or a workflow: capabilities added (by position in the new list, `+ N: <cap>`),
  narrowed, budgets (raised: governance; lowered: behavior), then for an agent its
  skills by name and `role, loop strategy or progress thresholds changed` (one text for
  the role, the model, the loop and the progress together) and the remote binding; for
  a workflow the steps (`+ step:` for each label of the new list that the old list does
  not have, then `- step:`; labels, not positions), the body changed with the same steps,
  the envelope, `ensures`, the handlers. Locks come last: `lockDiff` (members by name,
  then role holders by role then member), then `lockLimitsDiff`'s governance, then its
  behavior after the program's.
- A budget is shown dimension by dimension in the order spend, tokens, steps, time,
  agents. Amounts: tokens, steps and agents as integers; time as the view's own
  `duration` (whole hours `2h`, else whole minutes `20m`, else whole seconds `90s`,
  else `1500ms`; there are no days, and zero is `0h`); spend as `micros / 1_000_000` in JavaScript's
  number printing followed by the currency (`0.5 USD`, `1.25 USD`, `35.5 USD`); a
  dimension without a limit as `no limit`. Two currencies are not compared: a change
  of currency is a governance change. In `envelopeChanges` all the raised lines come
  before all the lowered ones.
- Paths are JSON Pointers with `~` as `~0` and `/` as `~1` in a name (`ptrToken`); a
  changed capability of a workflow's envelope is at `…/envelope/caps/<i>` when added and
  at `…/envelope/caps` (no index) when removed.
- What counts as changed: two definitions are the same if their canonical text is the
  same, whatever the order of members in the source; a capability's fs path inside an
  old path adds nothing, and an old path inside a new one is not taken away; methods
  widen if some method is new or none was named; versions compare segment by segment
  with a missing segment as 0 (`22.23` is `22.23.0`); an isolation floor and co-tenancy
  are compared as each data class has them in effect (a floor for `public` holds for all
  four classes), so a floor change on one class shows as several lines.
- `unchanged` has up to four lines, in this order: `external effects unchanged: <names>`
  or `no external effects, before or after` (when the sorted external effects of the
  workflows are equal), `contracts and their criteria unchanged`, `no authority added`
  (when no governance text starts with `+` or has `tier`, `data class` or `: methods `
  in it), `no budget raised` (when no governance text has `.budget.`).
- Markdown (`mdEscape`): in a heading, a paragraph or a plain list item, each of
  `\ ` * _ [ ] < > | ~` gets a backslash and a line break becomes a space; a change and
  the meta values are inline code spans with a space inside each fence, the fence
  one backtick longer than any run inside, and a `|` inside changed to `¦` (U+00A6) and
  a line break to a space; so `A|B` is `A¦B`, and a backtick in a name makes a
  two-backtick fence. The title is `<to.module>: <from.version> → <to.version>` (U+2192),
  the meta lines are `From`, `To` and `View` (`mandate/view/0.1, generated from the two
  programs`), the paragraph is `From <hash> to <hash>.`, an empty list is `none`
  (changes) or `—` (U+2014, unchanged). HTML (`htmlEscape`): `& < > " '` become
  `&amp; &lt; &gt; &quot; &#39;`; a change is `<li><span class="mono">…</span></li>`.
  The page and its style are in `doc.ts` and are the same for every case.

### Oddities pinned, not fixed

The port carries these over as they are. All are cases of the written pairs.

- `no authority added` and `no budget raised` look at the governance texts only. A
  changed envelope is the one line `~ W: envelope changed`, so a diff that raises an
  envelope's budget or adds a capability to it (`envelope-budget-raised`,
  `envelope-cap-added`) says `no authority added` and `no budget raised`; the same for
  `~ capability N changed` (`cap-spend-raised`) and `argument prefixes` (`cap-exec-args-prefix-added`).
- Steps are compared as a set of labels: a second `delegate` to the same skill, or
  reordered steps, is `the body changed, with the same steps` (`workflow-step-repeated`).
- A lock's `models`, `tariffs`, `modules` and `bindings` are not compared at all
  (`lock-models-and-tariffs-not-compared`: no change at all).
- `semanticDiff` does not open a capability over a component or an environment (it is
  given no modules): `~ capability Repos changed`; `governanceChanges` with the modules
  says which repository, path or command (`linked-capabilities-widened`).
- Narrowing an `exec` capability's command list, or changing any argument prefix, is a
  governance change (`capability_added`) both ways.
- Two kinds of text are never produced although the code has a branch for them: the
  `command` label of a scope (an `exec` capability is paired by its command list) and
  `s without a static scope (unbounded)` (a scope that was static and is not).

## corpus/

The compiled corpus: every call that the compiler's own tests (`compiler/test/*.test.ts`)
make to a front door of the compiler, with its input and its whole result, for
another compiler to make again and match. The tests build their inputs in code, so,
unlike `diagnostics/`, an entry carries its inputs: an entry and the shared items it
names are enough to make the call again.

### How it is made

`compiler/vitest.config.ts` has a collecting mode, on when `MANDATE_CORPUS=1` or
`MANDATE_UPDATE_VECTORS=1`. In it, every test file but `corpus.test.ts` runs first,
with `compiler/test/corpus-record.ts` as a setup file: it replaces the modules that
export a front door with the same modules whose door functions note each call (its
arguments as they come in, its return value as it goes out) and return what the door
returned, unchanged. A call that a door makes of another door, through another module,
is part of the outer call and is not noted again. Each test file writes what it noted
to a temporary directory. Then `compiler/test/corpus.test.ts` runs alone, merges the
notes and writes (with `MANDATE_UPDATE_VECTORS=1`) or compares (with `MANDATE_CORPUS=1`)
the files below. Without the mode the suite runs as it always has, and `corpus.test.ts`
checks the stored entries alone. How each door's arguments and return value are stored
is in `compiler/test/corpus-doors.ts`.

To write the corpus again after a change to the compiler or to a test:
`MANDATE_UPDATE_VECTORS=1 npm test` (or `npm test -w compiler`), the same command as
for every other vector file. Running it twice gives the same files: the entries are
sorted by `id`, the shared items by key, the notes by test file, and nothing depends on
the order in which vitest ran the files.

`corpus.test.ts` asserts:

- in every run, that every entry, made again from its stored input, gives exactly its
  stored result, compared as text (staleness; the test names each entry that does not;
  about 2 s);
- in every run, the limits below, that every shared item an entry names exists and
  every shared item is named, and that `summary.json` counts what the entries hold;
- in every run, that every code of `compiler/src/codes.ts` occurs in a stored result of
  the corpus or of `diagnostics/`, except the codes no input of a front door can give
  (`NOT_REACHABLE` in the test, with the reason for each, and only `MDT-E0902` today: the
  runtime raises it when a sandbox host cannot enforce an agent's requirement, and
  nothing in `compiler/src` gives it);
- in the collecting mode, that every test file wrote its notes and that the files are
  exactly what the suite calls now (completeness): a test that makes a new call fails it
  until the corpus is written again.

Every file is ASCII strict JSON within the Rust reader's limits: under 900 KB (a list is
split into numbered parts when a part would pass 800 KB), nesting up to 64, integers
only, no duplicate key, no lone surrogate (a character outside the BMP is its
surrogate pair of `\u` escapes). The corpus is at most 3 MiB in all; the test asserts
all of it.

### The front doors

A front door is a function of `compiler/src` that a user of the compiler calls (a CLI
command, a tool of the MCP server, the runtime) with what it was given (a text, a lock,
a patch, a program, a report) and that returns diagnostics. The doors, by the name an
entry carries:

| Door | Function | Called by |
|---|---|---|
| `load` | `load(text, kind)` | `mandate load`, `ir`, `fmt`, `mandate.apply_patch` |
| `check` | `check(text, kind, { modules, lock, claim })` | `mandate check`, `hash`, `view`, `sandbox`, `target`, `mandate.check`, the runtime |
| `load_modules` | `loadModules(sources)` | `--module`, the runtime's CLI |
| `check_patch` | `checkPatch(program, base, ops, modules)` | `mandate.apply_patch` |
| `apply_patch` | `applyPatch(program, base, ops, modules)` | `mandate patch` |
| `check_subprogram` | `checkSubprogram(input)` | the runtime's `check_program` and `submit_program` |
| `check_amendment` | `checkAmendment(input)` | the runtime's `request_amendment` |
| `validate_lock` | `validateLock(value)` | the runtime, on a package's lock (and `check`, given a lock) |
| `acs_target` | `acsTarget(program, modules, lock)` | `mandate target acs` |
| `denial_diagnostics` | `denialDiagnostics(program, report)` | `mandate check --denials` |

The other exported functions that return diagnostics are inner phases of a door, and
the door reaches all they can say, so they are not recorded even where a test calls them
directly: `parseStrictJson` (`load` of JSON returns its diagnostics as they are;
`reader.json` has its vectors), `parseMdt` and `validateIr` (`load`), `link`,
`resolveNames`, `roleChecks`, `importedMethods` and `staticCheck` (`check`),
`lockChecks`, `roleLockChecks`, `moduleLockChecks`, `sandboxLockChecks` and
`bindingChecks` (`check` with a lock; the runtime also calls the last two on a package
it has checked), `applyOps` (`apply_patch` and `check_subprogram`), `subprogramShape`
and `containment` (`check_subprogram`), `narrowings` (`check_amendment`). The MCP
server (`McpServer`, `callTool`) is a transport: its tools call `check`, `load`,
`loadModules` and `checkPatch`, and those calls are recorded as theirs.

The calls of the five test files that write vectors of their own
(`diagnostic-vectors.test.ts`, `diff-vectors.test.ts`, `schema-vectors.test.ts`,
`syntax-vectors.test.ts`, `vectors.test.ts`) are left out: what they call is in those
vectors already.

### entries-N.json

`{ "format": "mandate/vectors/corpus/entries/0.1", "part": N, "parts": M, "entries": [
… ] }`, one entry on each line, the entries in one order across the parts (by `id`, in
UTF-16 order). An entry:

- `id`: `<door>-<16 hex digits>`, the first 16 hex digits of the SHA-256 of the door,
  a line feed and the compact JSON text of `input`. Unique; the staleness test names an
  entry by it;
- `door`: one of the doors above;
- `files`: the test files that made the call (repository paths, in UTF-16 order). The
  same call made by several tests is one entry;
- `input`: the arguments, by name (below). A member that is not there is an argument
  that was not given (or `undefined`): the door takes its default;
- then exactly one of `result` (the return value, below), `result_text` (for a return
  value that holds a number that is not an integer: its exact text, `JSON.stringify` of
  the value as `result` would hold it; no entry has one today) and `throws` (the message
  of the error the door threw: `checkAmendment` and `checkSubprogram` throw for a
  `workflow` that is not a workflow with an envelope).

The inputs, by door. **T** is the key of a shared text, **V** the key of a shared JSON
value, and `modules` is `{ <module name>: V, … }` in the order the call gave them (the
loaded modules, `Record<name, Program>`, each module's IR):

- `load`: `source` (T), `kind` (`"mdt"` or `"json"`);
- `check`: `source` (T), `kind`, `modules`, `lock` (V, the lock as a value), `claim` (the
  option `checkSubprogram` passes, inline; no entry has one today);
- `load_modules`: `sources`, `[{ file, kind, text (T) }, …]`, in order; `file` is the
  name given for messages;
- `check_patch` and `apply_patch`: `program` (V, the IR the patch applies to), `base`,
  `ops` (the RFC 6902 operations, inline), `modules`;
- `check_subprogram`: `parent` (V), `modules`, `workflow`, `number`, `base`, `ops`,
  `lead`, `room` (inline, as `SubprogramInput` has them);
- `check_amendment`: `parent` (V), `modules`, `workflow`, `envelope` (inline, any JSON
  value: it is a lead's writing);
- `validate_lock`: `value` (inline, any JSON value);
- `acs_target`: `program` (V), `modules`, `lock` (V);
- `denial_diagnostics`: `program` (V), `report` (inline).

A result is the return value as plain JSON (what `JSON.stringify` keeps of it), every
member in the compiler's order, with three exceptions: a program's IR is not stored but
its digest, and so is a span table and each module that `loadModules` returns. A digest
is `sha256:` and the hex SHA-256 of a compact JSON text as `JSON.stringify` writes it
(no space; in strings `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\u00xx` in lower case for
the other characters below U+0020, every other character as itself, hashed as UTF-8):
of the IR in the member order the compiler built it (as in JavaScript, member names
that are array indices come first, in numeric order), and of a span table as `[[pointer,
[startLine, startCol, endLine, endCol]], …]` sorted by pointer in UTF-16 order. The
IR is left out because it is the size of the input and is pinned elsewhere (`hashes`,
and `programs/` for the golden programs); the diagnostics, `ok` and the hashes are
always stored whole. The results, by door:

- `load`: `{ program?, spans, diagnostics }` (`program` when the input was read);
- `check`: `{ program?, spans, diagnostics, ok, hashes? }` (`hashes`, `{ program, defs }`,
  when `ok`);
- `load_modules`: `{ modules: { <name>: digest, … }, problems: [{ file, diagnostics },
  …] }`;
- `check_patch`: `{ ok, hash?, diagnostics, governance, requires_approval, program? }`;
- `apply_patch`: `{ ok, diagnostics, governance, program?, hash? }`;
- `check_subprogram`: `{ ok, diagnostics, program?, hash?, workflow? }`;
- `check_amendment`: `{ ok, diagnostics, program?, hash? }`;
- `validate_lock` and `denial_diagnostics`: the array of diagnostics;
- `acs_target`: the whole target, `{ format, acs_version, program, binding, agents,
  profile, diagnostics }` (`program` and `binding` are hashes; `agents` holds each
  manifest and Rego text).

A diagnostic is as in `diagnostics/`: `code`, `severity`, `message`, `at` (`path`,
`span`), `docs`, and `facts` and `repair` where it has them, in that order as the
compiler builds it.

### shared-N.json

`{ "format": "mandate/vectors/corpus/shared/0.1", "part": N, "parts": M, "items": { …
} }`, one item on each line, by key in UTF-16 order across the parts. The texts and
the values that entries name, each stored once however many entries name it. The key
is the first 16 hex digits of the SHA-256 of the item's compact JSON text (of the text
as a JSON string, with its quotes, or of the value). An item is one of:

- `{ "text": "…" }`: a text;
- `{ "parts": [[piece, count], …] }`: a text over 4096 code units that repeats, as
  pieces: each piece repeated `count` times, all joined (the 1 MiB inputs of the tests
  of the limits);
- `{ "value": … }`: a JSON value: a program's or a module's IR, or a lock.

### summary.json

`{ format, calls, distinct_calls, entries, shared, by_door, by_file, by_code, left_out,
not_recorded }`: `calls`, the calls the suite made to a door (each test's, as often as it
made them); `distinct_calls`, how many distinct ones; `entries` and `shared`, how many
of each are stored; `by_door`, entries by door (every door, in the order above);
`by_file`, entries by test file; `by_code`, diagnostics in stored results by code;
`left_out`, `[{ id, door, files, reason }]`, the distinct calls not stored, with why;
`not_recorded`, calls whose arguments could not be noted at all, by reason. A call is
left out when the same input gave two results, when its input or result holds a lone
surrogate or a credential-shaped string (which the repository's secret scanner would
refuse), when its input holds a number that is not an integer (which the Rust reader
refuses: one call of `lock.test.ts` today), or when, made again from what would be
stored, it gives another result.
