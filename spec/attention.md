# Attention (0.7)

**Status: not implemented yet.** This page is the specification of release
0.7, written before its implementation, so that every part of it is built
against one text. Little of it runs today: the Rust compiler reads
`mandate @ 0.7` and checks a 0.7 program as the same program of 0.6, with
none of what this page adds yet, and the runtime runs no 0.7 package. Each part is implemented by the slice named in the table, and
its state is changed here when that slice is merged. Language 0.7 is read by
the Rust compiler alone: the TypeScript compiler stays frozen at 0.5 and
does not read it (E0103). While a slice has not landed, the runtime refuses
at load, by name, a 0.7 package that uses what that slice runs
(`unsupported_language`), as it did for 0.6; a version is never run on a
best-effort basis.

| Part | Slice | State |
|---|---|---|
| Version 0.7: `mandate @ 0.7`, `spec/ir-0.7.schema.json`, `spec/lock-0.7.schema.json`, the language gates; the runtime's 0.7 gates | RL1, B1 | the compiler's part implemented (RL1); the runtime's gates not implemented yet |
| `stage`: grammar, IR, printer; E1901, E1902 | RL2 | read and checked by the compiler since RL2; the runtime refuses a package that holds one (`unsupported_language`) until its slice B2 |
| `report`: grammar, IR, typing, purity, class and level of each field; E1903 to E1905; E1705 for `stage`, `report` and `owner` | RL3 | read and checked by the compiler since RL3, but for E1705 for `owner`, which is RL5's; the runtime refuses a package that holds one (`unsupported_language`) until its slice B2 |
| `asks`: the budget field, the attention bound, what each question site records; E1906 to E1908; `asks` in E1706 and E1709 | RL4 | read and checked by the compiler since RL4 (`crates/mandate-check/src/asks.rs`); the runtime refuses a package that declares `asks` (`unsupported_language`) until its slice B3 |
| The facts (`attention_facts`) | RL3, RL4 | the door, its stages and reports (RL3, `mandate/attention/0.1`), and the question sites, the effect sites, the totals, the declared `asks` and the rows of `on budget_exceeded` and of each `plan` (RL4), implemented; the shape and the closed list of kinds in `vectors/README.md` ("The attention facts") |
| `owner`; lock format 0.7 (`role_classes`, `promotion`); E1909 to E1911 | RL5 | not implemented yet |
| `std.patterns` 2.0.0 beside 1.0.0, version resolution, E1609; reports in a library's authority signature and in the semantic diff; the acceptance fixture | RL6 | not implemented yet |
| E1509; the doors `callable_connectors` and `tool_schema_digest` | RL7, B8 | the compiler's part implemented (RL7); the runtime's use of the doors not implemented yet |
| The attention view: the door `attention`, `mandate view --attention`, part of a 0.7 program's document | RP1, B9 | not implemented yet |
| The card of a 0.7 program | RP2 | not implemented yet |
| The MCP tools of 0.7 (`mcp_tools`); a native `mandate mcp` | RP3, RP4, B9 | the door `mcp_tools` and its data exist (RP3); neither server uses it yet, and the native server is not implemented yet |
| Stages and reports at run time; the stored facts and `facts_mismatch` | B2 | not implemented yet |
| `asks` at run time; the bound under the runtime's configuration and `attention_above_asks`; `asks_exhausted` | B3 | not implemented yet |
| Masking and `known` labels; a role's view of a 0.7 run; `WatchRun`; `ListWaits`; `program_started` and `program_ended` | B4 | not implemented yet |
| `mandate watch`, `mandate waits`, `mandate decide` | B5 | not implemented yet |
| Card approval of a workflow with an `owner`; the `promote` decision and the ladder; `mandate promote` | B6 | not implemented yet |
| The driver loop `mandate tick`; notifications | B7 | not implemented yet |
| The acceptance rehearsal | B10 | not implemented yet |
| The live session: its kit (B11), and the session the project's owner conducts | B11 | not implemented yet |

0.7 puts what a person will see into the program, and computes it before a
run. A program names its stages (`stage`) and what it tells each role
(`report`). The compiler works out, for each role, when the workflow can ask
it something, about what, at most how many times, by when, and what happens
when nobody answers: the **attention view**. A workflow can bound the number
of questions a run may put to people (`asks`), as a budget bounds money. A
workflow without an envelope can name the role that approves its card and
promotes it (`owner`), and a lock can bind each role to the highest data
class it may be shown (`role_classes`) and require that a workflow climb from
`design` to `read_only` to `live` by signed promotions (`promotion`).

While a run goes on, each role is handed what concerns it and nothing more:
a stream of its events, with every value above its class masked and every
value labelled with how it is known (`WatchRun`); the open decisions of all
runs that wait for it (`ListWaits`); and notifications of decisions and
outcomes, which carry ids and never content. A driver loop (`mandate tick`)
makes deadlines pass and escalations happen without a scheduler.

What a 0.7 package may do is bounded as before: authority by capabilities,
money and time by budgets, effects by prepare → authorize → commit. Nothing
of 0.7 widens authority. `stage` and `report` change no value of the run and
cost nothing in any budget.

## What 0.7 adds

| Addition | Where | Meaning |
|---|---|---|
| `stage <name> "<title>"` | statement | A marker that names the statements after it, up to the next stage |
| `report to <role> "<title>" { … }` | statement | Shows a role a few typed values, without stopping the run |
| `owner <role>` | workflow without an envelope | The role that approves the card and signs promotions |
| `asks` | budget of a workflow or an envelope | The most questions a run may put to people |
| `role_classes`, `promotion` | lock 0.7 | Each role's highest data class; the promotion ladder |
| `std.patterns` 2.0.0 | library | The three patterns with stages, and two reports in `BatchWithExceptions` |
| The attention view | view | Who is asked what, when, how often, and what happens with no answer |
| `stage_started`, `stage_ended`, `report`, `program_started`, `program_ended`, `asks_exhausted`, `promotion_accepted` | events | Progress, a report, a sub-program's start and end, the bound reached, a promotion |
| `promote` | decision kind | A signed promotion of a workflow from one mode to the next |
| `WatchRun`, `ListWaits` | control API | A role's projected events of a run; the open decisions of every run |
| `mandate view --attention`, `watch`, `waits`, `decide`, `promote`, `tick`, `run --limit asks=N`, native `mcp` | CLI | The view, a person's surface, the ladder, the driver loop |
| `notifications` | `mandate.runtime.json` | Channels per role: an HTTPS webhook through the egress proxy, or a local file |

## Invariants

0.7 binds three invariants of the design. INV-19 and INV-20 were left for a
later release by 0.5 and 0.6; INV-17 is widened.

| Id | Invariant |
|---|---|
| INV-17 | Everything shown to a person derives from an IR node and a journal record. Its class is set by the node's kind, not by its content |
| INV-19 | A view shows every value with how it is known: verified, counted or given by the run, a model's output, or outside content |
| INV-20 | A role is never shown, unmasked, data of a class above the one its binding allows |

How the rules of this page serve them:

| Rule | INV-17 | INV-19 | INV-20 |
|---|---|---|---|
| A stage and a report are IR nodes with constant titles; nothing a model writes becomes a title | yes | | |
| A report field is a pure expression of a displayable type; its class and level are the compiler's, from its type | yes | yes | yes |
| The facts are computed from the IR, stored with the run at its start and read back by every resume and replay (`facts_mismatch`) | yes | yes | yes |
| A role sees a `report` only when it is addressed to that role | yes | | yes |
| `WatchRun` projects each event type through a fixed allow-list of fields; it never copies an event's data | yes | | yes |
| Each value shown is `{ value, class, known }`; one above the role's class is `{ "$masked": class }` | | yes | yes |
| E1909: with a lock, no question, escalation or report shows a role data above its `role_classes` | | | yes |
| Notifications carry ids, kinds, roles, deadlines and a link, never content | yes | | yes |

The class that masks a value is read from the facts at the value's IR node,
never from the value: a value cannot raise or lower its own class, and what a
model writes does not decide what is masked.

## Language

### Version gating

A file names the version first: `mandate @ 0.7`. Everything on this page is
read only under that header. Every rule of 0.6 holds for a 0.7 program, and
a 0.6 program relabelled `mandate @ 0.7` checks as it did, with the same
diagnostics, but for what this page adds to every 0.7 program (E1509, E1909
with a lock, and the version of `std.patterns` it resolves).

- **Contextual words.** `stage`, `report`, `owner` and `asks` are contextual:
  the list of reserved words does not change. Each is read as a 0.7 word
  only where this page gives it a place; elsewhere, and in every program of
  0.1 to 0.6, it is an ordinary name, and the messages of 0.1 to 0.6 do not
  change. A slot named `owner`, as `MakerChecker`'s, stays a slot.
- **`stage`** starts a statement only at the start of a statement, followed on
  the same line by an identifier and then a string.
- **The schemas.** The IR of a 0.7 program is closed by its own schema,
  `spec/ir-0.7.schema.json`, and a 0.7 lock by `spec/lock-0.7.schema.json`:
  each is the 0.6 schema with this page's additions. The schemas of 0.1 to
  0.6, and what they accept, do not change. A 0.7 member in the IR of an
  earlier program is E0104, since the earlier schema closes its objects; in
  a lock older than 0.7, `role_classes` and `promotion` are E0140.
- **Unknown versions.** The cases and tests that hold `mandate/0.7` to be an
  unknown version move to `mandate/0.8`. E0103's list of known versions in the
  Rust compiler gains 0.7, and the stored results of earlier programs are
  compared without the entries the TypeScript compiler does not have, as for
  0.6.

### `stage`

```mandate
stage collect "Collect the items"
let items = source()
```

```text
stage := "stage" Ident String
```

A stage is a statement with no body. It names the statements after it, up
to the next `stage` or the end of the body. It opens no scope: a name bound
after a stage is seen after the next one, and the command ids of the body's
statements stay `body/i`, counted with the stage markers among them.

- **Where.** Only as a top-level statement of a workflow's body or of a
  pattern's body (E1901): not in a block, a branch, a loop, a map's body, a
  function or a handler. One written in a sub-program's own text is E1705; a
  sub-program that applies a listed shape has the pattern's stages
  ([below](#sub-programs-and-amendments)).
- **The list.** Stage names are unique within one body. A body that has
  stages starts with one. Each stage is followed by at least one statement,
  and the statement directly after it is not `on error`. Otherwise E1902.
- **The title** follows the [title rules](#titles) (E1902).
- **Nothing else.** A stage changes no value, reserves nothing and counts in
  no budget. A 0.7 program with its stage markers taken away has the same
  cost, node count, diagnostics (but for their paths), and architecture,
  authority and cost views.

A workflow that applies a pattern has the stages of the pattern's body. The
card's "What it does" and a run's progress are read from the stages.

### `report`

```mandate
report to reviewer "Batch done" {
  posted: len(posted), declined: len(reviewed.declined), failed: len(reviewed.failed)
}
```

```text
report := "report" "to" Ident String "{" field ("," field)* ","? "}"
field  := Ident ":" expr
```

A report shows one role a few values. It does not stop the run and waits for
nobody.

- **The role** names a role definition, and is a role site of the program as
  an approval's role is: E1501 when no definition has the name, E1502 with a
  lock that binds nobody to it. In a pattern it is one of the pattern's role
  slots (E1903), and the expansion puts the role the application binds in its
  place.
- **Fields.** One to sixteen, each a name and an expression; two fields of one
  report do not have the same name (E0121 in text, E1903 in IR).
- **What a field may be (E1904).** A field's expression is pure: it holds no
  `delegate`, `spawn`, `await`, `infer`, `verify`, `effect`, `changeset`,
  `map`, `plan`, `escalate`, `pause`, `human.*`, function call or tool call,
  and no `try`, which can end the run, and no block, which holds statements
  rather than a value. The one call it may hold is the built-in `len`; any
  other call, a built-in or not, is E1904. Its type is displayable: `Int`, `Dec`, `Bool`, `Text`, `Money`,
  `Duration`, `Time`, an enum, an `Option` or a `List` of one of these, or a
  record of these one level deep, each of them optionally inside `Verified`,
  `Inferred` or `Untrusted`.
- **Where (E1905).** Not in a map's body, in a loop without `max_iter`, in a
  function, in an `on error`, `on unmet` or `on budget_exceeded` handler, or
  in a test; nor directly before an `on error`, since a report changes no
  value of the run and the handler would handle the statement before it. A
  report is no statement of its block's value: a block's value is that of
  its last statement that is not a report or a stage. One written in a
  sub-program's own text is E1705; a sub-program
  that applies a listed shape makes the pattern's reports
  ([below](#sub-programs-and-amendments)).
- **The title** follows the [title rules](#titles) (E1903).
- **What it costs.** A report is pure, so it reserves nothing, counts in no
  budget, and does not count toward the limit of expanded nodes.
- **What is shown.** Each field is shown with its name, its value, its type,
  its data class (the class of the value, `Val.cls`) and how it is known (the
  level of its type, [below](#masking-and-how-a-value-is-known)). A value of
  `Inferred` type is a model's output and is shown as such (G09). The weakest
  wrapper decides, around the value and around its elements or fields, and a
  field is known no better than the weakest value it is made of, where its
  type does not say so: a text that interpolates a model's output, or a list
  typed by its first item, is a model's output. A count is the exception:
  what `len` counts does not lower the level, since a count is the run's own,
  while the class of what is counted stays the count's class.

### Titles

A stage's and a report's title is a constant string: the parser refuses
interpolation in it, as it does today. It holds 1 to 80 characters, counted
as Unicode scalar values, and no
C0 or C1 control, no format character (Unicode category Cf) and no
bidirectional control. Nor a line separator (U+2028) or a paragraph
separator (U+2029), which break the line in some renderers: a title is one
line (fact `rule: "separator"`). A title is written by the program's author, and a
person reads it on the card; a lead's model never writes one.

### `owner`

```mandate
workflow MatchInvoices = BatchWithExceptions<Invoice, Match, DraftId>(…)
  owner  accountant
  caps   Inbox, ErpRead, ErpDraft, ModelStd
  budget { spend: 20 USD, time: 2h, asks: 2 }
```

```text
workflow := "workflow" Ident params "->" type [ "owner" Ident ] ( envelope | "caps" … ) …
          | "workflow" Ident "=" application [ "owner" Ident ] "caps" … [ budget ]
```

`owner r` names the role that approves the workflow's card before any run
of it ([Card approval](#card-approval)) and signs its promotions
([Promotion](#promotion)). It is the counterpart, for a workflow without an
envelope, of an envelope's `owner`. It names a role definition and is a role
site of the program: E1501 when no definition has the name, E1502 with a lock
that binds nobody to it. A workflow that applies a pattern may write one; a
sub-program a lead writes may not (E1705). A workflow with an envelope
writes none: its envelope's `owner` has that place (E1910). A workflow with neither an `owner` nor an envelope
needs no card approval, as before; with `promotion: "required"` in the lock
it is E1910, since nobody could promote it.

### `asks`

```text
budget field += "asks" ":" Int
```

`asks: n` (an integer, at least 0) is the most questions a run of the
workflow may put to people ([The attention bound](#the-attention-bound)). It
is a field of a workflow's budget or of an envelope's budget, and of no other
budget (E1908). In a 0.7 budget the message for an unknown field lists `asks`
among the fields it knows. `asks` is not one of the budget's ledger
dimensions of the cost algebra (`BUDGET_DIMENSIONS`), and the `tables` door
does not change: the runtime keeps it as a dimension of its own
([`asks` at run time](#asks-at-run-time)).

### The IR

```json
{ "op": "stage", "name": "collect", "title": "Collect the items" }
{ "op": "report", "role": "reviewer", "title": "Items collected",
  "fields": [ { "name": "items", "value": { "op": "call", … } } ] }
```

| Member | Schema |
|---|---|
| `Stmt` `stage` | `op`, `name` (a name), `title` (a string of 1 to 80); no other member |
| `Stmt` `report` | `op`, `role` (a name), `title` (a string of 1 to 80), `fields` (an array of 1 to 16 `ReportField`); no other member |
| `ReportField` | `name` (a name), `value` (an expression); no other member |
| `Budget.asks` | an integer, at least 0 |
| `Def(workflow).owner` | a name |

`fields` is an array, not an object, because the canonical form (JCS) sorts
an object's members: the order the author wrote the fields in is the order a
person reads them. Both statements, `owner` and `asks` are part of the
program and of its hash: changing what a person will see is changing the
program.

## Static rules

Each rule has its code; the entries with their titles, explanations and
cases are in [`diagnostics.md`](diagnostics.md). E19xx is the family of this
release ("Attention").

| Code | Name | Raised when |
|---|---|---|
| E1901 | Stage out of place | A `stage` that is not a top-level statement of a workflow's or a pattern's body |
| E1902 | Malformed stage list | Two stages of one body with one name; a statement before the first stage of a body that has stages; a stage directly before another stage or at the end of the body; `on error` directly after a stage; a title that breaks the title rules (a control, format or bidirectional character, or a line or paragraph separator) |
| E1903 | Malformed report | A title that breaks the title rules (a control, format or bidirectional character, or a line or paragraph separator); two fields with one name in IR (text gets E0121); in a pattern, a role that is not one of its role slots |
| E1904 | Report field not shown | A field that is not pure, or whose type is not displayable |
| E1905 | Report out of place | A report in a map's body, a loop without `max_iter`, a function, a handler or a test, or directly before an `on error`. A `report`, a `stage` or an `owner` written in a lead's sub-program is E1705, with the fact `construct: "report"`, `"stage"` or `"owner"` |
| E1906 | Attention above `asks` | The static attention total of the workflow is above its declared `asks` |
| E1907 | Attention without a bound | The workflow declares `asks` and a question stands where the bound cannot count it (a loop without `max_iter`, recursion) |
| E1908 | `asks` out of place | `asks` in any budget but a workflow's or an envelope's |
| E1909 | Role shown data above its class | With a lock: a question asked of a role, the role a review escalates to, or a report to a role shows data above that role's class in `role_classes` |
| E1910 | Owner misplaced or missing | `owner` on a workflow with an envelope; or a lock with `promotion: "required"` and a workflow with neither an `owner` nor an envelope |
| E1911 | Lock field of a newer language | A lock's `role_classes` or `promotion` checked with a program older than 0.7 |
| E1609 | Module of a newer language | A program of 0.6 or later imports a module, or pins a library, whose language is newer than its own (a 0.6 program's lock that pins `std.patterns` 2.0.0); a program of 0.1 to 0.5 stays E1603 |
| E1509 | Criterion method name reserved | In 0.7: a criterion's verifier whose callee path is `verify` or `waiver` |

E1509 brings to the check what the runtime already refuses at load
(`reserved_method`, [`library.md`](library.md#the-wait-and-the-decision)):
the methods `verify` and `waiver` are the runtime's own. In a 0.6 program it
stays a refusal at load only.

Every new code has at least one conformance case of language `mandate/0.7`,
a passing program, one patch and the one code expected, and a test fails on a
0.7 code without one. Every walker of the compiler over statements handles
`stage` and `report` by name: a statement kind a walker does not name is a
compile error of the compiler, not a statement it skips.

## The attention bound

For each workflow the compiler computes, before any run, how many questions
a run can put to people, per role and in all. The same algebra gives the
attention view, E1906 and E1907, and the runtime's reservation for a
sub-program.

### What counts as a question

A question is a wait for a person that the program, as it is built, can
open. Each site counts as follows:

| Site | Counts |
|---|---|
| `verify` against a contract | 1 for each `human.approve` its criteria hold; approvals joined with `and` count one by one |
| `human.ask(…)` | 1, to its role |
| `escalate …` | 1, whatever its target: every `escalate` waits. To the role a `human(…, role: r)` target names, otherwise to no role |
| `pause` without `then` | 1, to no role |
| `supervise escalate` | 5 (`SUPERVISE_ESCALATIONS`), the most escalations it makes; the one constant of the specification, the compiler and the runtime, and a test holds it equal to the runtime's `MAX_ESCALATIONS` |
| An effect the program hands to a person | 1, to that role ([below](#effects-and-the-runtimes-configuration)) |
| A change set | 1 for each member's authorization that asks a person, and 1 for the set's approver |
| An action that touches a governance-class file (`GOVERNANCE_FILES`) | 1 to the file's owner, which takes the place of an authorization by policy; and when another role authorizes the action too, the owner's gate is 1 more |
| `human.review(…)` | 1 to its `role`, and 1 more to its `escalate_to`, marked `only: on_escalation` |
| `plan` | a dynamic row, "out of what is left of `asks`": each sub-program is held at its admission, and each amendment a lead asks for is counted when it is asked |

These are not questions, and count nothing: the `on budget_exceeded` handler
and the pause it falls back to (rows of their own, [below](#the-algebra)), a
raise of the limits, a reconciliation, a cancel and a halt. Nobody is asked
for them by the program: a person acts on their own.

An escalation of a review is a question: it spends another person's
attention. So the invoice flow's `asks` is 2.

### Effects and the runtime's configuration

The program itself hands an effect to a person, and the static total counts
it, in these cases:

- the envelope's `approve E by r`: to `r`;
- an environment whose tier is `by human`: to the tier's role;
- a member of a change set: to the member's approver;
- an irreversible action: under the runtime's default policy, to the role
  named `owner`.

That is the limit of what the compiler sees. The runtime's `authorize`
configuration (`StartRun`'s `authorize`, the runtime's policy) can hand
further effects to a person, or an irreversible one to policy, and no check
of the program can know it. So:

- **The facts list every effect site**, with its effect's name, its
  multiplicity, and whether the static total already counts it.
- **At the start of a 0.7 run**, the runtime computes the bound under its
  configuration: the static total, plus the multiplicity of every effect
  site that its configuration hands to a person and the static total does not
  count. A site its configuration hands to policy stays counted. It is a sum,
  so it is sound and not tight.
- **When an `asks` limit applies** and that bound is above it, the start is
  refused, `attention_above_asks`: the counterpart, at deployment, of E1906.
- **The attention view says so**: the runtime's configuration may add
  authorizations by a person, and a run whose configuration adds more than
  `asks` leaves room for does not start.

### The algebra

For a body `B` the compiler computes `A(B)`, a map from each role (and from
"no role") to a count in ℕ ∪ {∞}; `T(B)`, the total; and `R(B)`, the reports
to each role.

| Construct | `A` and `T` |
|---|---|
| A sequence of statements; the branches of `par` | Summed, role by role, and the totals summed |
| `if`, `switch` | The larger of the branches, role by role, and the larger of the totals |
| `loop … max_iter n` | The body's, times `n` |
| The branches of a `par` under `supervise restart_all` | Each branch's, times `RESTART_ALL_ROUNDS` (2, the runtime's rounds of `restart_all`; a test holds the two equal): a branch run again shows its reports and asks its questions again |
| A loop without `max_iter` that holds a question | ∞ |
| A map's body | 0: it holds no question (E1708), which the algebra asserts |
| A function call | The function's, times the multipliers around the call; a recursive call ∞ |
| A statement with `on error`, a `verify` with `on unmet` | The statement's own, plus the handler's |
| `on budget_exceeded` | Kept out of `T`; its questions are listed as rows marked "only if the budget runs out" |

Since a role's count and the total each take the larger branch, the counts of
the roles may add up to more than the total: a role is asked at most its
count, and the run asks at most the total.

The cost model of earlier releases counts a loop without `max_iter` once. The
attention bound does not: a question in such a loop is unbounded, and with a
declared `asks` that is E1907. Without `asks` the attention view shows the
bound as unbounded.

### What each question records

Each question site records, beside its count:

| Fact | Holds |
|---|---|
| `role` | The role asked, or none |
| `shown` | The highest data class of what the wait shows: the contract's arguments, the question's text, the review's map outcomes, the effect's parameters |
| `known` | How what it shows is known: `verified`, `plain`, `model` or `external`, from the level of its type |
| `deadline_ms` | Its deadline, when a constant `deadline:` gives one |
| `on_no_answer` | What happens when nobody answers: `waits`, `unmet`, `escalates { to, deadline_ms }`, `declined` or `refused_to_lead` |
| `stage` | The stage it stands in, if any |
| `multiplicity` | How many times it can be asked |

A review with `escalate_to` records `escalates` for its first role and
`declined` for the role it escalates to, and one without `escalate_to`
records `declined`; a lead's amendment request records `refused_to_lead`.

### Sub-programs and amendments

- **Admission (E1706).** Under an envelope that limits `asks`, a
  sub-program's questions come out of what is left of the run's `asks`. A
  sub-program need not name `asks` in its budget: its admission reserves its
  declared `asks`, or, when its workflow declares none, its static attention
  total. A sub-program that does not fit what is left, or whose total is
  unbounded and that declares no `asks`, is E1706, with `asks` as the
  dimension. The questions it asks then come out of that reservation. Under
  an envelope without `asks`, nothing is reserved.
- **What a sub-program may show.** A `stage`, a `report` or an `owner`
  written in a sub-program's own text is E1705 (fact `construct`: `stage`,
  `report` or `owner`). A sub-program whose workflow applies a pattern the
  envelope's `shapes` lists ([`library.md`](library.md#shapes), E1710) runs
  that pattern's stages and reports: the pattern's text is pinned by the lock
  and named on the approved card, so no lead wrote them. Their `stage_*`
  events carry `program`; their reports go to the role the application binds
  to the pattern's role slot, masked as everywhere. The check of a
  sub-program is not given the lock (`SubprogramInput`,
  `crates/mandate-check/src/doors.rs`), so E1909 is not raised at admission:
  what such a report shows is held by the runtime's masking alone.
- **Amendments (E1709).** In 0.7 an amendment's envelope that drops `asks`,
  adds it where there was none, or lowers it, narrows the envelope (E1709,
  dimension `asks`), as for every other dimension.
- **An amendment request** is itself a question, counted at run time when the
  lead asks it.

### The facts

`attention_facts` is a door of the Rust compiler (no TypeScript door has
it). For a workflow it gives, by IR node path:

- each stage: its name, title and position;
- each question site: the facts [above](#what-each-question-records);
- every effect site: its effect's name, its multiplicity, and whether the
  static total counts it ([above](#effects-and-the-runtimes-configuration));
- each report: its role, title and stage, its multiplicity (how many times
  one run can show it: one number for the report, not one per field), and
  for each field its name, type, data class and level;
- the totals `A`, `T` and `R`, the declared `asks`, and the rows of the
  `on budget_exceeded` handler and of each `plan`.

The attention view, E1906, E1907, E1909 and the runtime all read this one
structure. It is not part of the IR or of any hash.

## The attention view

The fourth view of a program, beside architecture, authority and cost. For
each role it says when the workflow can ask it something, about what, at
most how many times, by when, and what happens when nobody answers; and what
the workflow tells each role. It is made from the facts and the lock only.

- **Formats.** JSON, Markdown and HTML, from the door `attention`
  (`crates/mandate-views/src/attention.rs`), in the Node and the native
  command: `mandate view <program> --attention`, with the options and formats
  `view` takes.
- **In the document.** A 0.7 program's view document holds the attention view
  after its other views; the document of a program of 0.1 to 0.6 does not
  change.
- **MCP.** The `project` tool offers it ([The MCP server](#the-mcp-server)).
- **Roles.** Each role shows the members the lock binds to it, and the class
  it may be shown (`role_classes`, `internal` when the lock does not say).
- **The bound.** The view gives the total and the declared `asks`, or says
  that no bound is declared. It says that the runtime's configuration may add
  authorizations by a person that the program does not name, and that a run
  whose configuration adds more than `asks` leaves room for does not start
  (`attention_above_asks`).

### The invoice flow

For the acceptance program ([Acceptance](#acceptance)) the view is:

```text
# Attention: MatchInvoices
Stages: Collect the items · Work on each item · Decide on the exceptions · Commit what was accepted
At most 2 questions in all (asks: 2). Its card is approved, and it is promoted, by accountant (ana).
```

| Role | Members | May be shown | When | What is asked | At most | Deadline | If no answer |
|---|---|---|---|---|---|---|---|
| accountant | ana | up to confidential | Decide on the exceptions | Waive or decline the open items of the batch (Matched.totals may be waived); one decision about up to 60 items | 1 decision | 1 day from when it is asked | It goes to finance_lead, who has 1 day of their own |
| finance_lead | ben | up to confidential | Decide on the exceptions, only after the accountant's deadline | The same decision | 1 decision | 1 day from the escalation, which comes at the first tick after the accountant's day | Every open item is declined, by nobody; the run goes on and commits what passed |

What it tells whom:

| To | When | Report | Fields (class · how known) |
|---|---|---|---|
| accountant | Collect the items | Items collected | items (Int · confidential · counted or given by the run) |
| accountant | Commit what was accepted | Batch done | posted, declined, failed (Int · confidential · counted or given by the run) |

### The card of a 0.7 program

The card of a 0.7 workflow keeps every question of the 0.6 card and changes
these:

- **What it does** lists the stages, by title, in order.
- **When it asks whom** is made from the attention view. A review's two
  deadlines are stated exactly: the first counts from when the question is
  asked; the question then goes to `escalate_to` at the first tick after the
  first deadline has passed, and the escalated question's deadline counts from
  that escalation, not from the first deadline.
- **What it tells whom**: each report, with its role, stage, title and fields,
  each field with its class and how it is known. For an envelope with
  `shapes`, it says, per shape, what its sub-programs may report.
- **The owner**: for a workflow with an `owner`, that a member of that role
  approves the card before any run, with the members the lock binds to it.
  Nobody amends a workflow without an envelope.
- **The bound**: "At most N questions in all (asks: N)", or that it has no
  declared bound.
- **The ladder**: with `promotion: "required"` in the lock, that every run
  of `read_only` and of `live` needs a signed promotion by the owner role
  ([Promotion](#promotion)).

How a value is known is worded `verified`, "counted or given by the run"
(`plain`), "a model's output" (`model`) and "outside content" (`external`).

**The 0.6 card's wording stays.** The card of a 0.6 program states the
longest a review waits as its deadline, twice with an escalation ("for at
most 2 days (1 day, then 1 day more after it is escalated to …)"). That
figure is exact only for an escalation made at the very first deadline: the
runtime escalates at the first tick after it, and the escalated deadline
counts from then. The behavior does not change in 0.7, and the 0.6 card's
text stays as it is, since the digests of its outputs are fixed; this note
is the correction, and the 0.7 card states the two deadlines exactly.

## Lock 0.7

```json
{
  "lock": "mandate/lock/0.7",
  "modules": {},
  "libraries": { "std.patterns": { "version": "2.0.0", "digest": "sha256:…", "modules": { "std.patterns": "sha256:…" } } },
  "members": { "ana": { "keys": ["sha256:…"] }, "ben": { "keys": ["sha256:…"] } },
  "roles": { "accountant": ["ana"], "finance_lead": ["ben"] },
  "role_classes": { "accountant": "confidential", "finance_lead": "confidential" },
  "promotion": "required"
}
```

A lock of format `mandate/lock/0.7` has every field of a 0.6 lock and two
more, which exist only in format 0.7: in an older lock each is E0140,
reported at the lock's root, since the older schemas close their objects.
`roles` and `members` do not change.

| Field | Says |
|---|---|
| `role_classes.<role>` | The highest data class the role may be shown: `public`, `internal`, `confidential` or `restricted`. A role it does not name may be shown `internal`. A role that `roles` does not name is E0140 |
| `promotion` | `"required"`, its one value: a run of `read_only` or `live` needs a signed promotion ([Promotion](#promotion)), and every workflow has an `owner` or an envelope (E1910) |

- **E1909.** With a lock, the check compares the class each question shows
  (`shown`), and each report field's class, with the class of the role it
  is asked of, escalated to or reported to. Data above that class is E1909:
  nobody can decide on what they may not see. Raising the role's class in the
  lock, or taking the field away, mends it. The runtime masks as well
  ([below](#masking-and-how-a-value-is-known)): the mask is a second line, not
  the first.
- **Why in the lock.** A role's class is part of the deployment, as who holds
  the role is, and the lock is part of the package hash: raising a role's
  class is a new package, which a card approval of the old one does not
  cover.
- **Formats and languages.** A lock is read by the schema of its own format,
  whatever the program's language, as today (`lock_schema_of`). A 0.7 program
  accepts a lock of an older format: with no `role_classes` every role may be
  shown `internal`, and with no `promotion` there is no ladder. A 0.6 program
  given a 0.7 lock: its runs mask nothing and climb no ladder, so a
  `role_classes` or a `promotion` in that lock would not apply. The precedent
  is E1803, which refuses a lock's `isolation` and `egress` for a program
  before 0.5 rather than drop them silently (INV-11); the check refuses
  these two fields for a program older than 0.7 the same way, with E1911.

## `std.patterns` 2.0.0

The compiler embeds two versions of `std.patterns`:

- **1.0.0**, in `lib/std.patterns/`, as it is: its bytes and its digest do
  not change, and a test holds the digest. Every 0.6 lock that pins it keeps
  checking.
- **2.0.0**, in `lib/std.patterns@2/`: header `mandate @ 0.7`, `module
  std.patterns @ 2.0`, the same three patterns with the same slots, with
  stages, and two reports in `BatchWithExceptions`.

```mandate
{
  stage collect "Collect the items"
  let items    = source()
  report to reviewer "Items collected" { items: len(items) }

  stage work "Work on each item"
  let checked  = map it in items max max_items par concurrency {
    let out = delegate work(it)
    verify out against accepted(it, out)
  }

  stage exceptions "Decide on the exceptions"
  let reviewed = human.review(checked, role: reviewer, deadline: deadline, escalate_to: escalate_to)

  stage commit "Commit what was accepted"
  let posted   = map v in reviewed.accepted max max_items {
    effect commit(v) idempotent_by v.key
  }
  report to reviewer "Batch done" {
    posted: len(posted), declined: len(reviewed.declined), failed: len(reviewed.failed)
  }
  Batch { posted, declined: reviewed.declined, failed: reviewed.failed }
}
```

That is `BatchWithExceptions` 2.0.0's body. `FanOutMerge` 2.0.0 gains the
stages `work` and `merge`, and `MakerChecker` 2.0.0 the stages `make` and
`check`; neither has a report.

- **Which version.** The version the lock pins. Without a pin, 2.0.0 for a
  0.7 program and 1.0.0 for a 0.6 one. `mandate add std.patterns` pins the
  newest embedded version whose language is not newer than the program's.
- **A newer module (E1609).** A program of 0.6 or later that imports a
  module, or whose lock pins a library, of a language newer than its own is
  E1609: a 0.6 program cannot read 2.0.0, and a 0.6 program's lock that pins
  it is refused. A program of 0.1 to 0.5 that imports a 0.6 or a 0.7 module
  stays E1603.
- **Reports are governance.** In 0.7 a library's [authority
  signature](library.md#the-authority-signature) records, for each workflow
  and pattern, the reports it makes: each report's role or role slot and the
  highest class of its fields. The semantic diff records them too. A report
  added, or one whose highest class rises, is a governance change: `mandate
  upgrade` writes it into the lock only with `--accept-governance`, and
  `mandate publish` refuses it in a version that is not a major one (E1607).
  What a person is shown is part of what they approved.

## Run time

### Events

| Type | Class | Data |
|---|---|---|
| `stage_started` | S2 | `{node, stage, title, index, program?: {plan, number}}` |
| `stage_ended` | S2 | `{node, stage}` |
| `report` | S2, addressed | `{node, command, role, title, fields: [{name, value, class, known, type}]}` |
| `program_started` | S2 | `{plan, number, command, workflow, shape?}` |
| `program_ended` | S2 | `{plan, number, ok}` |
| `asks_exhausted` | S1 | `{command, kind, limit, settled, inside?}` |
| `promotion_accepted` | S0 | `{decision, member, role, key, from: {run, mode}, to}`, asked of the owner role |

- **No reclassification.** No event of 0.1 to 0.6 changes class: that would
  change the audit view and the OpenTelemetry export of older runs. These
  rows join the class table of [`boundary.md`](boundary.md#classes) and
  `EVENT_CLASSES` together, with their implementation.
- **Stages.** `stage_started` is written once for a stage node, however
  often the run is resumed and comes to it again, and nothing is written in
  a replay, as `map_started` is. `stage_ended` is written with the next
  stage's `stage_started`, or before the run's `run_succeeded`. `index` is the
  stage's position among its body's stages, from 0, as IR positions count. A
  stage of a sub-program names its `plan` node and number in `program`, and
  is shown under the stage of that `plan` node.
- **Reports.** `report` is written once for a report's command id, with each
  field's value, class, level and type. A value whose canonical form is longer
  than 64 KiB is written `{ "$omitted": { "bytes": n } }`. Nothing is written
  in a replay.
- **A report is addressed.** `shows()` gains one rule: a role's view, and
  every projection for a role, shows a `report` event only to the role it is
  addressed to. The audit view shows every report.
- **Sub-programs.** `program_started` and `program_ended` are written in 0.7
  runs only, as a sub-program starts and ends; the S4 events of 0.4
  (`program_submitted`, `program_admitted`, `program_refused`) do not change.
- **No new wait kinds.** The kinds of wait stay `input`, `decision`,
  `amendment` and `review`. The decision kinds gain `promote`; the members a
  decision record may have do not change.

### The stored facts

At the start of a run of a 0.7 package the runtime calls `attention_facts`
and stores what it gives as an artifact of the run, of media type
`application/vnd.mandate.attention+json`, named `attention` in the run's
manifest. A resume and a replay read the stored copy, never a new one. A
copy that is missing, or that does not hash to what the manifest names,
stops the run (`facts_mismatch`). It is the model of the stored running
program of 0.6 (`expansion_mismatch`): a compiler upgraded while a run goes
on does not change what that run shows, masks or counts.

### `asks` at run time

- **The limit.** At the start of a run of a 0.7 package, the run's `asks`
  limit is the declared `asks` of the workflow (or of its envelope) and the
  caller's `--limit asks=N` taken together as every other limit is
  (`minLimits`): with only the declared value, that value; with both, the
  smaller; with only the caller's, the caller's. It is kept as a row `asks` of
  the run's budget. With neither, the run has no `asks` limit and no such row,
  nothing is refused for it, and the attention view says that no bound is
  declared.
- **At the start**, when a limit applies, the bound under the runtime's
  configuration ([above](#effects-and-the-runtimes-configuration)) is compared
  with it, and a bound above it refuses the start (`attention_above_asks`).
- **Counting.** A question is counted when its wait opens, in the transaction
  that holds the run's lock and opens it, after the check for an existing
  row: a wait the journal already holds is not counted again. Outside a
  sub-program, it is counted when `settled + 1 ≤ limit`; inside one, it comes
  out of the sub-program's reservation. A review's escalation is counted in
  the transaction that escalates it.
- **When it is exhausted.** The question is not asked. Its command is
  recorded as failed with `Rejected(asks_exhausted)`, and one
  `asks_exhausted` event is written. What follows is the site's own outcome of
  a refusal, and nothing passes on its own:
  - a review's open items are declined;
  - a review's escalation is not made, and the review expires: every open
    item is declined, by nobody;
  - a lead's amendment request is refused to the lead;
  - any other question fails its step with `Rejected(asks_exhausted)`, which
    an `on error` handler may handle: a `human.approve` criterion is unmet,
    and an effect is not authorized and not committed.
- **Sub-programs.** An admission reserves the sub-program's declared `asks`,
  or its static total ([above](#sub-programs-and-amendments)); under an
  envelope without `asks`, nothing.
- **A raise.** `raise-limits` may raise a run's `asks` up to the declared
  value, and no further. Raising the bound by asking someone would spend the
  very thing that ran out, so nothing asks for it.
- **The bound holds.** A test hook asserts, for every test run of a 0.7
  package, that the questions it settled are at most the bound under the
  run's configuration: the static total in its stored facts, plus what its
  configuration adds ([above](#effects-and-the-runtimes-configuration)); a
  test of the sources asserts that every place the runtime
  opens a wait carries a site tag the compiler's algebra knows.
- Replay counts nothing: it reads what the journal holds.

### Masking and how a value is known

In a 0.7 run, each value shown to a role is shown as:

```ts
interface Shown { value: Value | { $masked: DataClass }; class: DataClass; known: "verified" | "plain" | "model" | "external" }
```

- **The cap.** A role's cap is `role_classes[role]` in the package's lock, or
  `internal` when the lock does not name the role.
- **The mask.** For a value at a node whose facts give class `c`: when `c` is
  above the cap, the value is `{ "$masked": c }`; otherwise it is the value.
  Either way it carries `class` and `known`. The audit view sees every value.
- **`known`** is the level of the value's type: `verified` for `Verified`,
  `plain` for a value the run computed or was given, `model` for `Inferred`,
  `external` for `Untrusted`. The weakest wrapper decides.
- **Where.** In the role view's `waiting`, `reviews` and `reports`; in the
  `WatchRun` projections of `wait_opened` and `report`; in `ListWaits`; and
  in what `mandate decide` and `mandate watch` print.
- **Older runs.** Nothing of a run of 0.1 to 0.6 is masked, and its views do
  not change.

### A role's view

A role's view of a 0.7 run (`runView(rt, run, { role })`, `mandate show
--role`) has the sections of 0.5 and 0.6, masked as above, and three more:

| Section | Holds |
|---|---|
| `stages` | Each stage: `{stage, title, state, started_at, ended_at}`, `state` one of `done`, `current`, `not_started`; a sub-program's stages under the stage of its `plan` node |
| `reports` | Each report addressed to the role, its fields as `Shown` |
| `programs` | How many sub-programs started and ended |

All three are S2 sections; `reports` holds only what is addressed to the
role. A run of 0.1 to 0.6 has none of them, so the digests of its views hold.

### `WatchRun`

```ts
interface ProjectedEvent { seq: number; at: number; type: string; class: ViewClass; data: Obj }
watchRun(run: string, audience: Audience, o?: { afterSeq?: number; limit?: number }):
  Promise<{ run: string; as_of: { revision: number; event: number }; events: ProjectedEvent[]; next: number; ended: boolean }>
```

`Runtime.watchRun` gives an audience the run's events after `afterSeq`, at
most `limit` (at most 500) at a time.

1. **The class.** An event is given only when `shows()` lets the audience see
   its class (S0 only when asked of the role; a `report` only when addressed
   to it).
2. **The fields.** Each event type is projected through a fixed allow-list of
   its fields; the projection never copies an event's data. Raw data of S1
   and S2 events can hold S0 and S3 content: `run_waiting` carries the whole
   request, `run_succeeded` the result, `run_failed` the error. An event type
   with no entry is given as `{seq, at, type, class}` only. A test requires
   every event type the runtime writes to have an entry, or an explicit
   "nothing" entry. The allow-list is a table beside the event-class table of
   [`boundary.md`](boundary.md#classes), added there with its implementation.
3. **The values** of the projections of `wait_opened` and `report` are
   masked and labelled.

The audit audience gets every event with its data. Following a run is
polling with a cursor the client keeps (`next`); there is no listener and no
subscription.

### `ListWaits`

```ts
interface WaitItem { run; tenant; workflow; package; revision; command; kind: "input" | "decision" | "review" | "amendment";
  asked_of: string | null; since: number; deadline: number | null; escalates_to: string | null;
  on_no_answer: string; stage: string | null; subject: string; shown: Shown[] }
listWaits(who: { role: string } | { member: string }, o?: { tenant?: string }): Promise<WaitItem[]>
```

`Runtime.listWaits` gives every open decision, across all runs, for a role or
a member: a person asks "what waits for me", not "what waits for this role
in this run".

- It reads the `commands` rows in state `waiting`, not `runs.waiting`: a
  `par` can leave several waits open in one run. A partial index on
  `commands (run_id) where state = 'waiting'` serves it.
- A member is resolved to roles through each package's own lock.
- A wait that asks no role is listed to every role the package's lock binds,
  with `asked_of: null`.
- What it shows is masked and labelled, by the role it is asked of.

### Card approval

A 0.7 workflow with an `owner` starts, in any mode, only after a member of
that role has approved the package: a signed decision of kind `envelope`
whose subject is the package hash, as an envelope's approval
([`envelope.md`](envelope.md#approving-an-envelope)). `approveEnvelope` and
`mandate approve-envelope` take such packages too; without an approval that
holds, the start is refused (`unapproved_envelope`). A workflow without an
`owner` and without an envelope needs no approval, as before.

### Promotion

Promotion is enforced only when the package's lock says `promotion:
"required"`. Then:

- a `design` run needs no promotion;
- a `read_only` run needs a promotion from a succeeded `design` run of the
  same package and workflow;
- a `live` run needs a promotion from a succeeded `read_only` run A of the
  same package and workflow, which carries the digest of the shadow diff of A
  against D, the `design` run named by the promotion A itself started under
  (A's manifest `promotion`).

A promotion holds for every later run of the same package hash and workflow
in its target mode, not for one run. A changed package is a new hash, and
needs new promotions.

A promotion is a signed decision record of kind `promote`, made by a member
of the workflow's `owner` role, or of its envelope's `owner` role:

```text
{ kind: "promote", package: P, run: A, revision: <A's final revision>,
  subject: digest("request", { format: "mandate/promotion/0.1", package: P, workflow,
                               from: { run: A, mode, manifest: <A's manifest hash> }, to,
                               shadow: digest(shadowDiff(D, A)) | null }),
  role: <owner>, member, key, payload: digest("request", { to }) }
```

`to` is `read_only` or `live`; `shadow` is `null` for a promotion to
`read_only`. `Runtime.promote(pkg, signed)` checks the record as every
decision is checked, in that order: who signed, what it is for, the role. A
record whose subject is not the one the runtime computes is refused by the
existing subject check (`invalid_decision` with the reason
`subject_mismatch`). It is refused `bad_promotion` when its from-run did not
succeed, is not a run of the same package and workflow, or is not in the
mode directly below `to` (`design` for `read_only`, `read_only` for `live`:
`design` → `live` is refused). Otherwise it is stored. `startRun` looks for a
promotion that still holds, and without one refuses the start
(`unpromoted`). The new run's manifest records its `promotion`,
and its journal `promotion_accepted`.

`mandate promote <run> --to read_only|live --key FILE [--yes]` is guided: it
shows the run, and for a promotion to `live` the shadow diff as counts of the
actions that would apply, per effect, never their parameters; it asks to
confirm unless `--yes`, signs and submits.

### The driver loop

```sh
mandate tick [--follow] [--interval 10s] [--no-notify]
```

Without a scheduler nothing makes a deadline pass. `mandate tick` makes one
pass, or with `--follow` one pass every `--interval` until SIGINT:

1. it selects the runs in state `waiting`;
2. for each, it builds a runtime for the run's package and calls `tick`: a
   decision expires, a review is escalated or expires, a timer is due;
3. in a 0.7 run, `tick` acts on every open wait whose deadline has passed,
   the `commands` rows in state `waiting`, and not only on the one
   `runs.waiting` names, since a `par` can leave several open; a run of 0.1 to
   0.6 keeps today's behavior, the wait `runs.waiting` names;
4. in a 0.7 run, `tick` also drives a run whose wait's command is no longer
   waiting (decided, and not driven on since);
5. unless `--no-notify`, it runs the notification pass.

`tick` acts under the run's lock and is idempotent, so a `mandate tick` and a
Temporal worker acting on the same run do not act twice.

### Notifications

Notifications are sent only for 0.7 runs.

- **A cursor pump.** Each channel keeps a cursor per run that only moves
  forward (`notify_cursors`), in the shape of the OpenTelemetry export: no
  queue is written in the journal's transactions. Delivery is at least once:
  a receiver may get one notification twice, and knows the repeat by its
  `id`.
- **Order and dead letters.** A channel's cursor for a run does not move
  while a notification is being retried, so a run's notifications reach a
  channel in order. After six failed attempts the notification is recorded in
  `notify_dead` and the cursor moves past it.
- **The owner role** of a run is its workflow's `owner`, else its envelope's
  `owner`. A workflow with neither has none.
- **What is sent.** S0 events (`wait_opened`, `review_requested`,
  `review_escalated`, `amendment_requested`) go to the channels of the role
  asked; a wait that asks no role goes to the owner role's channels, and with
  no owner role it is not notified (it is still listed by `ListWaits`). S1
  events (`run_succeeded`, `run_failed`, `run_cancelled`,
  `run_attention_required`, `budget_exceeded`, `asks_exhausted`) go to the
  roles configured with `outcomes: true` and to the owner role, or, with no
  owner role, to those roles alone. Nothing of S2 to S4 is sent.
- **The id** is `digest("operation", { format: "mandate/notification/0.1",
  channel, run, seq })`: the runtime's digest of a domain and a value,
  `sha256:` and the hex of SHA-256 over `mandate/operation/0.1\n` and the
  value's canonical form, as an operation key is. It is the same for every
  retry of one notification.
- **The payload** is fixed, and built from ids, the kind, the role, the
  deadline, `as_of` and a link, never from a step's content:

```ts
interface Notification { format: "mandate/notification/0.1"; id: string /* digest("operation", { format, channel, run, seq }) */;
  kind: "decision" | "outcome"; event: string; class: "S0" | "S1"; tenant; run; workflow; package; seq; at;
  role: string | null; command: string | null; deadline: number | null; as_of: { revision; event }; link: string | null }
interface Notifier { name: string; send(n: Notification): Promise<void> /* throws NotifyFailed { retryable } */ }
```

- **The link** is made from the configuration's `link` template, which may
  hold only `{run}`, `{role}` and `{command}`, each URL-encoded.
- **A notification is no decision.** It points to where a decision is made;
  a decision is made only by a signed record.

Two adapters:

| Adapter | Sends |
|---|---|
| `webhook` | An HTTPS POST, only through the egress proxy, in a gateway session with a credential name, header and template as a connector's are; redirects are an error (`redirect: "error"`); 10 seconds at most; an `x-mandate-notification` header with the id; retried with backoff. Its body is `mandate` (the JSON above) or `text` (`{"text": <a fixed sentence>}`, which Slack and Teams accept). There is no body template |
| `file` | One JSON line per notification, appended to a local file |

The configuration is in `mandate.runtime.json`, not in the lock:

```json
"notifications": {
  "channels": { "acct": { "webhook": { "url": "https://hooks.acme.example/mandate", "credential": "acct_hook", "header": "authorization", "template": "Bearer {secret}", "format": "mandate" } },
                "local": { "file": ".mandate/notifications.jsonl" } },
  "roles": { "accountant": { "channels": ["acct", "local"], "outcomes": false } },
  "link": "https://mandate.acme.example/runs/{run}"
}
```

The webhook's `header` and `template` are where the credential goes, as for a
connector; they shape no body. A configuration that cannot be used, a
webhook whose URL is not `https` among them, is refused by name,
`bad_notification_channel`.

- **Why not in the lock.** The lock is part of the package hash: an address
  changed there would be a new package, and its card approval would fall.
  Where a notification goes is the operator's, as the egress proxy's
  configuration is.
- **Why no body template.** A template would be a channel out of the run:
  whatever it could reach, it could send.
- The journal's hot path is not touched: the pump reads it after the fact.

### Storage

| Table or member | Holds |
|---|---|
| `notify_cursors(channel, run_id, seq, at)` | Each channel's cursor per run |
| `notify_dead(channel, run_id, seq, attempts, reason, at)` | Each notification given up |
| index `commands_waiting` on `commands (run_id) where state = 'waiting'` | `ListWaits` |
| manifest `attention` | The stored facts |
| manifest `promotion` | The promotion the run started under |

Every new table is in the test's list of tables, and every rule holds on
PGlite and on PostgreSQL.

### Refusals

| Name | When |
|---|---|
| `facts_mismatch` | At a resume or a replay: the stored facts are missing or do not hash to the manifest's |
| `attention_above_asks` | At a start, when an `asks` limit applies: the bound under the runtime's configuration (the static total plus the effect sites its configuration hands to a person) is above it |
| `bad_promotion` | `promote`: the from-run did not succeed, is not of the same package and workflow, or is not in the mode directly below `to` |
| `Rejected(asks_exhausted)` | A question past the run's `asks`, or past a sub-program's reservation; with the event `asks_exhausted` |
| `unapproved_envelope` | At a start: a workflow with an `owner` whose package no member of the owner role has approved |
| `unpromoted` | At a start, with `promotion: "required"`: a `read_only` or `live` run without a promotion that holds |
| `bad_notification_channel` | A `notifications` configuration that cannot be used |
| `unsupported_language` | At load, until its slice lands: a 0.7 package that uses a construct this runtime does not run yet |

## The command line

```sh
mandate view <program> --attention …                      # with what `view` takes
mandate approve-envelope <program> --key FILE …           # a workflow with an owner too
mandate promote <run> --to read_only|live --key FILE [--yes]
mandate watch --member M --out DIR [--follow] [--refresh SECONDS]
mandate watch <run> --role R --jsonl
mandate waits (--role R | --member M) [--tenant T] [--json]
mandate decide --key FILE
mandate tick [--follow] [--interval 10s] [--no-notify]
mandate run … --limit asks=N
mandate mcp                                                # native, in crates/mandate-cli
```

- **`watch --member M --out DIR`** writes script-free HTML: `index.html` with
  all the member's waits and runs, and one page per run and role the member
  holds, `<run>.<role>.html`, with that role's view, each file written
  atomically. `--refresh SECONDS` adds a `<meta refresh>`; without it there is
  none. `--follow` keeps the pages up to date.
- **`watch <run> --role R --jsonl`** prints the role's projected events, one
  JSON line each.
- **`waits`** prints the open decisions of a role or a member, as `ListWaits`
  gives them, optionally of one tenant; `--json` prints them as JSON.
- **`decide --key FILE`** lists the waits, shows one masked and labelled,
  with its deadline and what happens with no answer, asks for a choice, asks
  to confirm, signs and submits. It can be scripted on standard input.
- Everything these commands print of a run passes through the terminal
  escaping of 0.6 (`terminalText`).
- There is no server, no listener and no authenticated read: whoever reaches
  the database reads everything already, so the pages and the stream are
  projections for people, not a security boundary of their own.

## The MCP server

The two servers, the Node one and the native `mandate mcp`, serve the same
tools:

- `check` takes `libraries`, and finds the embedded `std.patterns` by
  default;
- `project` offers the card and the attention view, and takes `lock` and `libraries`;
- `spec` takes two more values of its existing `section` parameter,
  `patterns` and `attention`;
- the tool list of 0.7 is data from one door of the Rust compiler,
  `mcp_tools`. The frozen TypeScript tool list in the `tables` door does not
  change.

**The server only computes.** No tool signs, approves or promotes: an agent
never holds a person's key, and a card approval, a decision and a promotion
are made only by a person, with `mandate approve-envelope`, `mandate decide`
and `mandate promote`.

The native server is a JSON-RPC loop on stdio in `crates/mandate-cli` that
reads bounded lines, with the Node server's limits and its two protocol eras,
and serves the embedded `spec/core.md`. The same recorded conversations run
against both servers ([`mcp.md`](mcp.md)).

## Carry-over from 0.6

Each behind the 0.7 gate; nothing of 0.6 changes:

- the runtime binds only the connectors the compiler says can be called (door
  `callable_connectors`);
- the door `tool_schema_digest`, which the runtime uses once vectors show it
  equal to its own schema digest;
- E1509.

## Acceptance

The criterion of the release: someone who does not write software has the
flow set up, approves its card, takes it from `design` to `read_only` to
`live`, and finishes the work seeing only S0 to S2.

**The program.** `fixtures/attention/invoices.mdt` is
`fixtures/library/invoices.mdt` with four lines changed (46 lines): the
header `mandate @ 0.7`, `module acme.finance.invoices @ 2.0`, `owner
accountant` after the application, and `budget { spend: 20 USD, time: 2h,
asks: 2 }`. Its lock, `fixtures/attention/invoices.lock.json`, is the 0.6
lock with `"lock": "mandate/lock/0.7"`, `std.patterns` pinned at 2.0.0,
`"role_classes": {"accountant": "confidential", "finance_lead":
"confidential"}` and `"promotion": "required"`.

**The rehearsal** (`runtime/test/attention-acceptance.test.ts`), the gate of
the slices, with a scripted person, a scripted authoring agent, a simulated
ERP and mailbox, in Docker and in CI:

| Criterion | How it is shown |
|---|---|
| An agent sets the flow up | The scripted agent drives the MCP server: a draft with `asks: 1`, E1906, a patch, a clean check, and the card and attention view as fixed texts |
| A person approves the card | A member of `accountant` signs an `envelope` decision on the package hash; without it, `unapproved_envelope` |
| `design` → `read_only` → `live` | Signed promotions; a `live` start without one is `unpromoted`; the shadow diff's digest is checked |
| It finishes seeing only S0 to S2 | The people read only `watchRun` for their role, `listWaits({ member })` and the HTML pages, and decide with `mandate decide` |
| Notifications carry only S0 and S1 | The file adapter's lines |
| `asks` holds | At most 2 questions settled; with `--limit asks=1` the escalation is `asks_exhausted` and the items are declined |
| A missed deadline escalates | The simulated clock passes one day, `mandate tick`, `review_escalated`, and `finance_lead` decides; in a second run both deadlines pass |
| Replay gives the same result | `replayRun` equals the live result |
| A mutation for every new rule | Every 0.7 code has a case; each run-time refusal has a test (`asks_exhausted`, `unpromoted`, `facts_mismatch`, a forged `promote` or one from the wrong role, `bad_notification_channel`) |
| 0.1 to 0.6 unchanged | The golden files, the default views' digests and the vectors do not change |

"It finishes seeing only S0 to S2" is these checkable statements, over
everything the scripted people read:

- no event of class S3 or S4 is in any role's stream;
- every value shown carries a `class` and a `known` label;
- no value whose class is above the role's class in `role_classes` is shown
  unmasked;
- no notification is of an event outside the S0 and S1 lists above; its
  members are exactly the payload's; and no value of any command's result
  appears in it, as a substring of its text.

**The live session.** The kit (`fixtures/attention/live/`: a guide, a
configuration, a lock template, and `scripts/live-session.mjs` with the
egress proxy, a fake ERP and mailbox, a simulated or a real model, and the
authoring agent's path over `mandate mcp`) lets the project's owner conduct
the session with a person. Its result is written into this page's status
table.

## Not in 0.7

- A hosted console, a network listener, authenticated or identity-scoped
  reads; OIDC or passkey signers; separation of duties (the author of a
  program approving its own governance change).
- `asks` per role; nested stages; dynamic titles; reports in a sub-program a
  lead writes.
- Webhook body templates; e-mail, SMS, and adapters native to Slack or other
  chat tools.
- Reclassifying an existing event; masking in runs of 0.1 to 0.6.
- The commands that control a run in the native `mandate`; 0.7 in the
  TypeScript compiler; a language server; a SQLite store.
- Amending a package whose lock pins a library; telling an accepted lock from
  a hand-copied pin.
- Revoking a promotion.
- A review's path under Temporal; a session against a real MCP server.
- The four points left open from 0.5.
