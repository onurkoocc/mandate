# Canonical IR, 0.1 and 0.2

The canonical IR is the source of truth for a Mandate program (design doc
4 §3.3). It is JSON, described by the closed schema in
[`ir.schema.json`](ir.schema.json) (JSON Schema draft 2020-12). The `.mdt`
text form is a projection: the compiler lowers text into IR and prints IR
back as text, and both directions keep the program hash.

## Reading IR

A conforming reader rejects, rather than repairs:

- a `language` other than `"mandate/0.1"` or `"mandate/0.2"` (E0103).
  Other versions are migrated explicitly, never loaded on a best-effort
  basis;
- a 0.2 field in a 0.1 program (E0104);
- any field the schema does not define (E0104);
- duplicate object keys, before schema validation (E0102);
- numbers that are not integers within ±(2^53−1), and `-0` (E0106).
  Decimals travel as strings (`{"op":"dec","value":"0.85"}`), money as
  integer micro-units plus an ISO 4217 code, durations as milliseconds;
- strings containing a lone UTF-16 surrogate (E0107). Text is kept exactly
  as written; no Unicode normalization is applied;
- input over the 0.1 limits: 1 MiB of source, nesting depth 64, 64
  definitions (E0105).

Schema validity is necessary, not sufficient: names are then resolved
(E0120), and the static checks (types, effects, capabilities, budgets,
contracts, delegation) run on the result. See [`checks.md`](checks.md).

## Canonical form

Two programs that mean the same thing should hash the same (§3.1), so the
producer fixes the order of everything whose order carries no meaning:

| Collection | Representation |
|---|---|
| definitions, record fields, contract criteria, `par` branches, test handlers | objects keyed by name |
| `use` list, imported names, `caps` lists, effect sets, `requires caps` | arrays sorted by the JCS form of each item |
| parameters, enum members, union variants, statements, call arguments | arrays in source order |

Optional fields are omitted, never written as `null` or `false`.

## Hashing

Hashes are SHA-256 over the RFC 8785 (JCS) serialization, with a domain
prefix that includes the program's language version `<v>`, `0.1` or `0.2`
(§3.4):

```text
P = SHA256("mandate/program/<v>\n" || JCS(program))
D = SHA256("mandate/def/<v>\n"     || JCS(definition))
```

A 0.1 program keeps its hash under a 0.2 compiler, and the same definition
hashes differently in 0.1 and 0.2.

They are written as `sha256:` followed by 64 lowercase hex digits. A hash
identifies content; it does not say who produced it.

## Patches

`mandate patch` applies RFC 6902 `add`, `remove` and `replace` operations to
a program. A patch names the program hash it was written against; if the
program has changed since, it is refused with `stale_base` (E0130) instead of
being merged by position. Patches that add a capability, raise a budget,
remove an acceptance criterion or add an `irreversible` effect are reported
as governance changes (§13.2).

## Text projection

The `.mdt` grammar follows doc 4 Appendix A, widened to cover every example
in doc 4. Comments are not part of the IR, so `mandate fmt` drops them.

The design (§3.3) defers the text form to 0.2 and keeps JSON as the only
authoring surface in 0.1. This implementation ships the text form anyway,
because writing test programs as JSON IR is slow and error-prone; the IR stays
authoritative, and `examples/fixbug/fixbug.ir.json` is the committed source
for the FixBug example, with `fixbug.mdt` as its projection.

A file whose first line is `mandate @ 0.2` is a 0.2 program; a file without
that line is 0.1. `mandate fmt` writes the line for 0.2 programs only.

## What 0.2 adds

0.2 adds two optional fields to a local agent (design doc 4 §8.2; BACKLOG
K9):

| Field | Text | Meaning |
|---|---|---|
| `loop` | `loop react` or `loop plan_execute` | How the agent's skills without a body run. `react` when absent |
| `progress` | `progress { window: 8, repeats: 3, stall: 5 }` | When the loop counts as stuck. Each field is optional; these are the defaults |

Both are part of the definition hash, so changing a threshold is a change
to the program. `repeats` may not exceed `window` (E0104). The runtime's
use of them is described in [`runtime.md`](runtime.md#agent-loops-82).
