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
| `asks`: the budget field, the attention bound, what each question site records; E1906 to E1908; `asks` in E1706 and E1709 | RL4 | read and checked by the compiler since RL4 (`crates/mandate-check/src/asks.rs`), and run since B3 |
| The facts (`attention_facts`) | RL3, RL4 | the door, its stages and reports (RL3, `mandate/attention/0.1`), and the question sites, the effect sites, the totals, the declared `asks` and the rows of `on budget_exceeded` and of each `plan` (RL4), implemented; the shape and the closed list of kinds in `vectors/README.md` ("The attention facts") |
| `owner`; lock format 0.7 (`role_classes`, `promotion`); E1909 to E1911 | RL5 | not implemented yet |
| `std.patterns` 2.0.0 beside 1.0.0, version resolution, E1609; reports in a library's authority signature and in the semantic diff; the acceptance fixture | RL6 | implemented but for the acceptance fixture: both versions embedded, `std_patterns_for`, E1609, reports in the signature and the diff, `mandate add --program` (RL6); the acceptance fixture not written yet |
| E1509; the doors `callable_connectors` and `tool_schema_digest` | RL7, B8 | the compiler's part implemented (RL7); the runtime's use of the doors not implemented yet |
| The attention view: the door `attention`, `mandate view --attention`, part of a 0.7 program's document | RP1, B9 | not implemented yet |
| The card of a 0.7 program | RP2 | not implemented yet |
| The MCP tools of 0.7 (`mcp_tools`); a native `mandate mcp` | RP3, RP4, B9 | the door `mcp_tools` and its data exist (RP3); neither server uses it yet, and the native server is not implemented yet |
| Stages and reports at run time; the stored facts and `facts_mismatch` | B2 | not implemented yet |
| `asks` at run time; the bound under the runtime's configuration and `attention_above_asks`; `asks_exhausted` | B3 | implemented (`runtime/src/asks.ts`, the count in `Journal.openWait`; the hook `runtime/test/asks-hook.ts` and the test of the sources in `runtime/test/asks.test.ts`) |
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
with a lock, and the version of `std.patterns` it resolves). A 0.6 program
that imports `std.patterns` read 1.0.0; relabelled, without a pin it would
read 2.0.0, with its stages and reports, and so the faithful relabelling
pins 1.0.0. The gates that relabel do so in one helper on each side
(`relabelled_modules` in `crates/mandate-testkit/tests/common`,
`modulesUnder` in `runtime/test/relabel.ts`): a check of the relabelled
program is given the module of 1.0.0, which stands for a pin of it.

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
  typed by its first item, is a model's output. The level travels with the
  value as its class does: a name a `let` binds is known as what it was bound
  to, a template no better than the weakest part it interpolates, a list or a
  record than its weakest item or field, and a function's result no better
  than what it returns and what its call hands it (so `let k = "{v}"` with `v`
  a tool's output, then a field `k`, is outside content). A verification
  starts it again: a verified value is verified. A count is the exception:
  what `len` counts does not lower the level, since a count is the run's own,
  while the class of what is counted stays the count's class. The same holds
  for what a question shows (`known`, below).

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

**The class of a function's result.** In 0.7 a call of a function is of the
data class of what the function returns, typed in its body with its
parameters of their declared types (its last value and every `return`'s),
as well as of its arguments' class. Before 0.7 it is of its arguments' class
alone, so a function that reads classified data itself (a `data.read` of an
environment's declared read) and returns it as an unclassified type such as
`Text` hands back a value of a lower class than the data, and every rule that
reads a value's class reads that lower one (E0220 for a model's
`max_class`, among them). A program of 0.1 to 0.6 is checked as before; in
0.7 such a value keeps its class, and the rules refuse what they refuse for
the data itself.

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
| `kind` | Which row of the table above it is: `verify`, `ask`, `escalate`, `pause`, `supervise_escalate`, `effect`, `changeset`, `governance`, `review` or `plan` |
| `wait` | The wait in its static form (below) |
| `role` | The role asked, or none |
| `shown` | The highest data class of what the wait shows: the contract's arguments, the question's text, the review's map outcomes, the effect's parameters; in a function or a contract, at least the class of what its calls and `verify`s hand it, through every caller |
| `known` | How what it shows is known: `verified`, `plain`, `model` or `external`, from the level of its type and of what it is made of, through bindings and functions' results (as a report's field, above); in a function or a contract, no better than what its calls and `verify`s hand it |
| `deadline_ms` | Its deadline, when a constant `deadline:` gives one |
| `on_no_answer` | What happens when nobody answers: `waits`, `unmet`, `escalates { to, deadline_ms }`, `declined` or `refused_to_lead` |
| `stage` | The stage it stands in, if any; for a site in a function or a contract, the stage of its calls when they all stand in one |
| `multiplicity` | How many times it can be asked |
| `contract`, `criterion` | A `verify` row only: the contract and the criterion whose approval it is, by their names as the program writes them |
| `items` | A review's rows only: the most items its one decision is about, the bound of the map whose outcomes it reviews (its `max`, else the envelope's `agents`), or `"unbounded"` |
| `waivable` | A review's rows only: the criteria its roles may waive, as `Contract.criterion`, in the order of the program (`accept` before `invariant`); empty when the contract has no `waive by` |

A review with `escalate_to` records `escalates` for its first role and
`declined` for the role it escalates to, and one without `escalate_to`
records `declined`; a lead's amendment request records `refused_to_lead`.
A `plans` row records the `path` and the `wait` of the amendment request.

The role a question names is a role definition, and nothing a run computes:
in 0.7, a `role:` of `human.ask`, `human.approve`, `human(…)` or `supervise
escalate`, a review's `role:` or `escalate_to:`, or an approval's
`distinct_from:` whose name a parameter or a binding in scope also has is
E1501 (`shadowed_by`), since a run would read that name's value instead.
The rule holds for every definition a question of the program reaches, the
contracts its `verify`s reach and the functions its calls reach, through
any number of others, whatever module defines them and whatever language
that module is written in: a module of 0.1 to 0.6 is checked on its own, or
imported by a program of its own language, as before, and a program of 0.7
that reaches such a question is refused where its own text reaches it (the
`verify` or the call), with the definition, its module and the path in it
(`definition`, `module`, `at`). E0502 for a cycle in another module's
definitions, and E1907 for a question in one, are reported in the same way.

**The static form of a wait.** `wait` is the site's IR path in the running
program and the part the runtime adds for the wait it opens there:
`/contract/<group>/<criterion>[/all/i]/call` after a `verify` for an
approval, `/escalate` after a delegation, `/authorize` after an effect or a
change set's member (`…/members/<m>/authorize`) or a change set,
`/governance` for an owner's gate that comes before another role's
authorization (one that takes the place of a policy is at `/authorize`),
`/amendment` after a `plan` for a lead's amendment request, and nothing for
`human.ask`, `escalate`, `pause` and a review. `kind` and `wait` name one
site, but for a review and its `only: on_escalation` row, which share the
review's wait; a `plans` row's `wait` names it among the plans. A run's
command id is not this text: it adds a loop's iteration (`@i`), a restarted
branch's round (`#allN`), a map's item (`[i]`) and a delegation's attempt
(`#k`, before `/escalate`); a function's site stands under its call
(`<call>>f/…` for `/defs/f/…`), a contract's under its `verify`
(`<verify>/contract/require/i/…` and `<verify>/contract/<group>/<criterion>/…`
for `/defs/C/require/i/…` and `/defs/C/<group>/<criterion>/by/…`), a
handler's under its episode (`/defs/W/on/i@n/…`), a lead's amendment request
under the turn and the tool call it is made in
(`<plan>/step/<n>/tool/<k>/amendment` for `<plan>/amendment`,
`runtime/src/plan.ts` and `runtime/src/loop.ts`), and a sub-program's under
its command (`<plan>/program/<n>…`). The runtime tags each wait it opens with
its static site, its kind and its static wait, and the facts are the list
those tags are held to.

**Under the runtime's configuration the suffix does not name the row.** The
table chooses `/governance` or `/authorize` from the role the program names.
The runtime's configuration (`StartRun.authorize`) may hand an action the
program leaves to policy to a person, or one a person authorizes to policy
(an envelope's `approve` it cannot change), and then the suffix of the wait
the runtime opens is not the one the facts record: `authorization()` in
`runtime/src/interp.ts` opens `<effect>/governance` for the owner before
another person's `<effect>/authorize`, and `<effect>/authorize` for the owner
alone when the action would otherwise go to policy. So a run tags each wait
from what `authorization()` decides, not from its command id, by this rule:
the owner's gate of an effect is the `governance` row of that effect's path,
whichever suffix its wait has; an authorization by a role is the effect's
row (the change-set member's, the set's): a `questions` row when the static
total counts it, else the effect's `effects` row. When the role that
authorizes is the owner, one wait is both, and it is the effect's row. The
facts serve the rule as they are: among the rows of kind `effect`,
`changeset` and `governance`, a kind and a path name one row, and every
effect and every member of a change set has one `effects` row by its path,
counted or not, a batch commit step's among them; a change set's own
approval is always a `questions` row, which the configuration does not
change.

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
stages `work` ("Work on each part", before its map) and `merge` ("Merge the
results", before its merge), and `MakerChecker` 2.0.0 the stages `make`
("Make the result") and `check` ("Check the result", before the check and
its verification); neither has a report. The type parameters, slots, run
parameters and results of the three, and the type `Batch`, are 1.0.0's, a
test holds byte for byte (`crates/mandate-check/tests/patterns_0_7.rs`); so
are their bodies with the stages and reports taken away. A test holds the
digest of each version as a literal: 1.0.0's is the one every lock of 0.6 in
the repository pins.

- **Which version.** The version the lock pins. Without a pin, 2.0.0 for a
  0.7 program and 1.0.0 for a 0.6 one. One function of the compiler chooses
  (`std_patterns_for`, from the program's language and the pinned version),
  and every place that reaches the built-in goes through it: the check, the
  views, the card, a sub-program's and an amendment's check, and `add`,
  `upgrade` and `publish`. A pin of a version the compiler does not embed,
  or of another digest, is refused as before (E1605, `version_differs` or
  `digest_differs`, against the version of the program's language). A 0.7
  program whose lock pins 1.0.0 reads 1.0.0 (a module of 0.6 is read by 0.7),
  and its expansion has no stage. A check given a module named
  `std.patterns` that is one of the embedded versions' (by its program hash)
  reads that version when its lock pins none: the given module stands for a
  pin, so that a caller that holds the version a check read (a sub-program's
  parent's, a relabelled program's) can hand it on; any other module of that
  name is compared with the built-in as before (E1605, `given_differs`).
- **Doors given no lock (`std_patterns`).** Every door that reads
  `std.patterns` and is given no lock takes one optional input,
  `std_patterns`, a version such as `"1.0.0"`: the version the lock of the
  program (or of a sub-program's parent) pins. They are the checks of a
  sub-program and of an amendment (`i.std_patterns`), `subprogram_linked`,
  `attention_facts` (`opts.std_patterns`), the views `architecture`,
  `authority` and `cost`, `program_doc`, `semantic_diff` and `diff_doc`. It
  is read by `std_patterns_for` alone. A version the compiler does not embed,
  or one that is not a version, is refused by the door (`bad_input`: `"3.0.0"
  is not a version of std.patterns this compiler embeds (1.0.0, 2.0.0): a pin
  of std.patterns is one of them`), never read as the default. A door given a
  lock reads the lock's pin, and refuses a `std_patterns` that names another
  (`the lock pins std.patterns 1.0.0, and std_patterns names 2.0.0: give the
  one the lock pins, or none`). Without it, a door answers as before: the
  version of the program's language, or the lock's pin where it is given a
  lock (the views and the diff now read it too, as the card did). What a
  document says it was generated from does not change with it. The runtime
  hands the pin of the package's own lock to the check and the facts of a
  lead's sub-program of a 0.7 package, so that what runs and what is shown is
  the version the lock pins.
- **`mandate add`.** `mandate add std.patterns` pins the newest embedded
  version whose language is not newer than the program's, and for a 0.7
  program writes a lock of format `mandate/lock/0.7` (a new lock, or an
  older one lifted to 0.7, whose fields are those of 0.6 and two more it
  need not have). The program is the one `--program FILE` names (`add` and
  `upgrade`, in both executables; a program that does not load is reported
  against its file, exit status 1); without it the program is taken to be
  of 0.6, and `add` writes exactly what it wrote before 0.7. The door takes
  it as `language` (`mandate/0.7`). A range can still pin 1.0.0 for a 0.7
  program (`std.patterns@^1.0`); for a 0.6 one, `^2.0` finds nothing
  (E1606, `no_version`).
- **A newer module (E1609).** A program of 0.6 or later that imports a
  module, or whose lock pins a library, of a language newer than its own is
  E1609: a 0.6 program cannot read 2.0.0, and a 0.6 program's lock that pins
  it is refused. A library's language is the newest of its modules'. The
  `use` is refused at `/uses/<i>` (facts `module`, `module_language`,
  `language`), whatever gave the module (the check's modules, a library, the
  built-in), and the pin at `/libraries/<name>` (facts `library`, `version`,
  `library_language`, `language`): a 0.6 program whose lock pins 2.0.0 and
  imports it has both. A module of a library that imports a module of a
  newer language does not check (E1601, `module_does_not_check`). A program
  of 0.1 to 0.5 that imports a 0.6 or a 0.7 module stays E1603. E1609 is a
  code of 0.7 whose cases are programs of 0.6: no program of 0.7 can meet it.
- **Reports are governance.** In 0.7 a library's [authority
  signature](library.md#the-authority-signature) records, for each workflow
  and pattern of a module of 0.7, the reports it makes: each report's role
  or role slot, its title, and the highest class of its fields (`reports:
  [{ role, title, class }]`, in the order of the body; `[]` for one that
  makes none). The signature of a module of 0.6 records none and does not
  change by a byte. A report added (by its role and title, or one more of
  one) or one whose highest class rises widens the signature (`what:
  "report"`), a governance change by the rule of every widening: `mandate
  upgrade` writes it into the lock only with `--accept-governance`, and
  `mandate publish` refuses it in a version that is not a major one (E1607).
  A report taken away, or one whose class falls, is not. A report addressed
  to another role slot is another report: one added. What a person is shown
  is part of what they approved.
- **A class that depends on the application.** A workflow's field is typed
  by the static checks, as the attention facts are, and its class is its
  value's. A pattern is not typed on its own: what a field holds comes from
  what the application binds (`len(items)` keeps the class of what it
  counts, and `items` is what the application's `source` gives, of
  `List<Item>`), so its class is known only in each workflow's expansion.
  The signature of a pattern records a field that names anything (a slot, a
  run parameter, a name a statement bound, a constant) as `applied`, "what
  the application binds", which ranks above every data class, and a field
  of literals alone as `public`, a literal's class. This is conservative (a
  field records the most it could show, so no application can make it rise
  unseen), deterministic (it reads the field's expression, not a typing of
  some application) and readable ("shows what the application binds" in the
  diff). A pattern whose body changed has another shape too, a widening of
  its own. A workflow's field the typing does not reach is recorded
  `applied` as well: what is not known is never read as low. Both
  `BatchWithExceptions` 2.0.0 reports record `{ role: "reviewer", class:
  "applied" }`; a workflow that applies it records the bound role and the
  class of its expansion (`accountant`, `confidential` in the invoice flow).
- **The semantic diff.** The diff of two programs of 0.7 records, for a
  workflow written out in both, what its reports show, by the same record
  and comparison: a report added or raised is the governance change
  `report_widened` ([`views.md`](views.md)), one taken away or lowered a
  behavior change. A workflow that applies a pattern changes by its
  application (`application_changed`), and a new workflow by its
  capabilities, as before.

## Run time

### Events

| Type | Class | Data |
|---|---|---|
| `stage_started` | S2 | `{node, stage, title, index, program?: {plan, number}}` |
| `stage_ended` | S2 | `{node, stage}` |
| `report` | S2, addressed | `{node, command, role, title, fields: [{name, value, class, known, type}]}` |
| `program_started` | S2 | `{plan, number, command, workflow, shape?}` |
| `program_ended` | S2 | `{plan, number, ok}` |
| `asks_exhausted` | S1 | `{command, kind, limit, settled, inside?}`: the question's command and kind, the run's `asks` limit and what it had settled, and the sub-program it was asked in |
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
  the run's budget (`budgets`: its `limit_value` the limit, its `settled` the
  questions asked). With neither, the run has no `asks` limit and no such row,
  nothing is refused for it, and the attention view says that no bound is
  declared. A caller's `asks` limit for a package of 0.1 to 0.6, whose runs
  count no questions, refuses the start (`unsupported_limit`); a run of 0.1 to
  0.6 never has the row.
- **`asks` and the other dimensions.** `asks` is no dimension of the cost
  algebra: no command's cost or reservation holds it, a delegation's budget
  does not name it, and `costDims` leaves it out. It is a dimension of the
  run's budget wherever the runtime walks those rows: the view's budget table
  and the envelope's remainder (with the envelope's declared `asks`), a
  lead's `room.left`, `raise-limits`, an amendment that raises the
  envelope's `asks` (the limit rises to it, as every raised dimension does),
  and `run_accepted`'s and `limits_raised`'s `limits`.
- **At the start**, when a limit applies, the bound under the runtime's
  configuration ([above](#effects-and-the-runtimes-configuration)) is compared
  with it, and a bound above it, or an unbounded one, refuses the start
  (`attention_above_asks`) before anything is written. An effect site is
  handed to a person by the configuration when `StartRun`'s `authorize` names
  its effect `by: human`, its facts' row says `counted: false`, and it is no
  batch commit step; the configuration is fixed at the start and stored with
  the run, so this is known before the run, and holds inside its
  sub-programs too.
- **The run's own reservation.** With a limit, the start reserves the bound
  under the configuration for the run's own program's questions (a
  `reservations` row of dimension `asks` under the command `/defs/<workflow>`).
  A question of the run's own program is counted against it, and is refused
  when it has none left; sub-programs and a lead's amendment requests come out
  of what is left of the run's `asks`, so that they never use up the
  questions the card promised the run's own program:
  `room.left.asks = limit − the run's own reservation − the reservations of
  sub-programs in flight − what ended sub-programs and amendment requests
  settled`, which is the budget row's `limit − settled − reserved`.
- **Counting.** A question is counted when its wait opens, in the transaction
  that holds the run's lock and opens it, after the check for an existing
  row: a wait the journal already holds is not counted again, so two drivers
  of one run count it once. The budget row's `settled` takes one more, and the
  reservation it is counted against one less, in that transaction: a crash
  before it commits counts nothing and opens nothing, and one after it finds
  the wait. Inside a sub-program it comes out of the sub-program's
  reservation; a lead's amendment request out of what is left. A review's
  escalation is counted in the transaction that escalates it, against the
  reservation of the program it was asked in.
- **Site tags.** Every wait the runtime opens for a person in a run of 0.7
  records in its `wait_opened` its static site, `site: {kind, path, wait}`:
  its kind of the closed list, the IR path of its construct in the program
  that runs it (a function's site under `/defs/f/…`, a contract's under
  `/defs/C/…`, a sub-program's in its own program), and the wait in its
  static form. The owner's gate of an effect is the `governance` row of the
  effect's path, whichever suffix it has; an authorization by a role is the
  effect's row, a `questions` row when the static total counts it, else its
  `effects` row, `counted: false`, which the configuration must hand to a
  person. A wait asked in a sub-program records the sub-program's command in
  its `commands` row (`inside`).
- **The `on budget_exceeded` handler.** Its questions, and the pause it falls
  back to, are not counted against `asks` and recur once per episode: their
  tags carry `only: "budget_exceeded"`.
- **When it is exhausted.** The question is not asked. Its command is
  recorded as failed with `Rejected(asks_exhausted)`, and one
  `asks_exhausted` event is written; no `wait_opened`, no `review_requested`,
  no `amendment_requested`, so no role is told of a question (the roles with
  `outcomes` and the owner role are told of the `asks_exhausted`, S1). What
  follows is the site's own outcome of a refusal, and nothing passes on its
  own:
  - a review's open items are declined, by nobody;
  - a review's escalation is not made, and the review expires: every open
    item is declined, by nobody;
  - a lead's amendment request is refused to the lead (`declined`, with the
    reason `asks_exhausted`);
  - any other question fails its step with `Rejected(asks_exhausted)`, which
    an `on error` handler may handle: a `human.approve` criterion is unmet
    (its evidence says `exhausted`), an effect is not authorized and not
    committed, a change set is not approved and nothing of it is committed.
- **Sub-programs.** Under a run with an `asks` limit, an admission reserves the
  sub-program's declared `asks`, or its static total
  ([above](#sub-programs-and-amendments)), plus the effect sites the run's
  configuration hands to a person that its static total does not count, out
  of what is left (`program_admitted`'s `reservation.asks`); one that does not
  fit, or whose count is unbounded, is refused as E1706 with dimension
  `asks`. Without a limit, nothing. Every sub-program of a parent of 0.7 has
  its facts stored at its admission. Its reservation is released when it ends,
  succeeded or failed, with what it did not use. The admission is one
  transaction: a crash before it commits admits nothing, and one after it
  finds the admission and reserves nothing again.
- **An amendment.** An amendment request of a run of 0.7 carries the facts of
  the amended workflow, stored with it. Under an `asks` limit, one whose bound
  under the configuration is above the limit it would have, or whose growth
  over the run's own bound does not fit what is left with the request itself,
  is refused to the lead (`attention_above_asks`), and nobody is asked. Once
  approved, the facts in force are the amended workflow's
  (`package_amended`'s `attention`): the run, its resumes and its replays read
  them from then on, and the run's own reservation moves by what its bound
  moves by, up by what is left at most. A sub-program in flight keeps its
  reservation.
- **A raise.** `raise-limits` may raise a run's `asks` up to the declared
  value, and no further (`above_program_budget`). A run whose workflow
  declares none was limited by its caller alone, and its limit is raised as
  any other such limit is. Raising the bound by asking someone would spend the
  very thing that ran out, so nothing asks for it.
- **Per role.** Only the total is held. The runtime's policy can hand a
  counted authorization to another role, so the count of a role is not.
- **The bound holds.** A test hook (`runtime/test/asks-hook.ts`) asserts, for
  every test run of a 0.7 package, that every wait it opened carries a tag of
  the closed list naming a row of the facts in force where it stands, and
  that the questions it settled are at most the bound under the run's
  configuration: its own program's at most the bound of its facts, each
  sub-program's at most its own facts' (D5: a lead's amendment requests are
  bounded only by the run's `asks`); a test of the sources asserts that every
  place the runtime opens a wait carries a site tag the compiler's algebra
  knows.
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
  `external` for `Untrusted`. The weakest wrapper decides, and a value is
  known no better than what it is made of where its type does not say so
  ([What is shown](#report)).
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
| `budgets` row `asks` | A run's `asks` limit (`limit_value`) and the questions it asked (`settled`); none without a limit |
| `reservations` rows of dimension `asks` | The run's own reservation, under `/defs/<workflow>`, and each sub-program's, under its command: what each may still ask |
| `wait_opened.site` | A wait's static site, `{kind, path, wait, only?}` (0.7 runs only) |
| `commands.inside` of a wait | The sub-program a wait of a 0.7 run was asked in, against whose reservation its review's escalation is counted |
| `package_amended.attention`, an amendment request's `attention` | The digest of the amended workflow's facts, stored with the request and in force once it is approved |

Every new table is in the test's list of tables, and every rule holds on
PGlite and on PostgreSQL.

### Refusals

| Name | When |
|---|---|
| `facts_mismatch` | At a resume or a replay: the stored facts are missing or do not hash to the manifest's |
| `attention_above_asks` | At a start, when an `asks` limit applies: the bound under the runtime's configuration (the static total plus the effect sites its configuration hands to a person) is above it, or unbounded. Also a diagnostic to a lead whose amendment request would raise the run's bound above its limit, or beyond what is left |
| `unsupported_limit` | At a start: a caller's `asks` limit for a package of 0.1 to 0.6, whose runs count no questions |
| `unknown_role` | In a run of 0.7, an approval whose `role:` or `distinct_from:` names no role definition (a value of the run would choose who decides); the run stops for a person, and nobody is asked |
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
- `caps_of` takes `lock` and `libraries`, as `check` takes them, so that
  the authority of a program that applies a pattern of a pinned library can
  be read;
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
