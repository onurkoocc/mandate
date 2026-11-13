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
