# Static checks, 0.1 (Gate 1)

`mandate check` runs these after the IR is valid and every name resolves.
They follow design doc 4 §5–§10. This page records how the reference
compiler reads the rules where the design leaves room, so that a second
implementation can match it. Codes are listed in
[`diagnostics.md`](diagnostics.md).

The checker sees the canonical IR, so a `.mdt` file and its `.ir.json`
produce the same diagnostics in the same order.

## What the checker does not know

Types imported from other modules (`use company.domain.{Issue}`) and
standard-library calls the compiler does not describe have an unknown type.
An unknown type is compatible with everything and carries no effects, so
missing knowledge never produces an error. The described part of the
standard library is in `compiler/src/std/std.ts`. Reads from the outside
world (`fs.read_text`, `net.https.get`, `human.ask`) return `Untrusted<T>`.

## Epistemic types (§5.2)

```text
Verified<T, C>  <:  T  <:  Inferred<T>  <:  Untrusted<T>
```

- Model output (`infer`, a skill's declared `Inferred<T>`) cannot be used
  where `T` is expected (E0210). Untrusted content cannot either (E0211).
- `Verified<T, C>` is accepted only where contract `C` is expected (E0212).
- Taint is contagious (R6). A field of an `Inferred` value is `Inferred`;
  an operator over an `Inferred` operand is `Inferred`; a record literal
  built from `Inferred` parts is `Inferred` as a whole.
- `verify x against C(…)` yields `Verified<T, C>`. Contract arguments may
  be unverified, because checking them is what the contract is for.
- Prompts have an instruction region and a data region (§5.4). Only
  constants and `T` or `Verified<T>` values may appear in the instruction
  region. `Untrusted` and `Inferred` values go through `quote(…)` (E0215).
- Evidence, Authorization, Receipt and Verified are produced only by the
  runtime. A skill, an `infer`, an extern or a record literal that produces
  one is rejected (E0213).
- `peek(…)` reads model output as a plain value and is reported (W0207).

## Decisions (§8.10)

A switch on a raw `Decision<T>` is rejected (E0231). A policy function
(`threshold`, `top_margin` or `abstain_if`) first turns it into
`DecisionOutcome<T>`. A switch on that outcome must handle `Uncertain`
(E0230). A `Choice<T>` should include an out-of-scope option (`Other`,
`Irrelevant`, `OutOfScope` or `None`), otherwise W0232 is reported. A
`Choice<T>` may have at most 255 options (E0233).

## Data classes (§5.5)

A type declaration may carry a class:

```mandate
type CustomerRecord = { name: Text, iban: Text } classified restricted
```

In IR this is `{"kind": "type", "type": …, "class": "restricted"}`. A value
has the highest class of the types and inputs it came from. Model output
inherits the highest class of its input, so a later delegate that receives
it receives that class too. `model.infer(…, max_class: c)` sets the highest
class a model may receive; the default is `internal`. Sending more is
E0220. This applies to `infer` in a workflow and to delegates whose skill
uses `Model`.

## Effects (§6)

- A function or skill must declare every effect it uses, including effects
  of the functions it calls (E0401). Public functions must declare their
  effects. Unknown effect names are E0402.
- Critical effects declare `idempotency required` and are called with
  `idempotent_by` (E0403). Their parameters cannot be `Inferred` or
  `Untrusted` (E0210, R4).
- Critical effects run only in workflows, never in a function, a skill or a
  contract (E0408).
- Irreversible effects need an earlier `human.approve` in the same body, or
  an argument verified by a contract with a `human.approve` criterion
  (E0405).

E0406 and E0407 belong to the prepare → authorize → commit expansion and
arrive with the runtime.

## Capabilities (§7)

- Each effect needs a capability: `Fs.Read` ← `fs.read`, `Fs.Write` ←
  `fs.write`, `Net` ← `net.https`, `Model` ← `model.infer`, `Exec` ←
  `exec`, and a user or std effect ← the capability its `requires caps`
  names (for std `git.*` effects, `git.pr`). `Human`, `Time`, `Random` and
  `Delegate` need none. A workflow body or an agent's skill that uses an
  effect with no capability for it is E0301.
- Paths are compared by segment after resolving `.` and `..`, so
  `/work/repo/src2` is not inside `/work/repo/src`.
- `narrow(…)` must stay inside the capability it narrows (E0305, C3).
- One capability lies inside another when it has the same constructor, its
  scope lies inside the other's, and it allows no more than the other does.
  For `model.infer`, that means no higher `max_class` and, when the outer
  one names a `tier`, the same tier: tiers are not ordered, so
  `model.infer(tier: economy)` is not inside `model.infer(tier: standard)`.
  For `exec`, every `args_prefix` must extend one of the outer
  capability's prefixes. `[["-q", "test", "-Dtest=A"]]` is inside
  `[["-q", "test"]]`, and `[["-q"]]` is not. A capability without
  `args_prefix` allows any arguments.
- Delegation (C2, §9.1). Without `with caps`, the delegate gets
  `A.caps ∩ avail(ctx)`. With `with caps K`, each capability in K must lie
  inside both the context's and the agent's capabilities (E0701). K
  replaces the agent's capabilities of the same kind and leaves the other
  kinds as they are. This is how §7.4 reads:
  `with caps RepoWrite.narrow("/work/repo/src")` narrows the write scope
  without taking the model capability away. What the delegate ends up
  with must cover the effects the skill declares, otherwise E0301 is
  reported at the delegation.
- Write capabilities (`fs.write`, `git.pr`) of different `par` branches
  must not overlap (E0320, C5). A branch's write scope is what it delegates
  plus the write capabilities its own effects use.
- A capability that nothing uses is W0310.

## Budgets (§8.6)

The checker adds up the budgets a workflow hands out and compares them with
its own (E0501). A delegate's budget is the one written at the call, else
the skill's, else the agent's. A call to a function with a budget counts
that budget. A call to a function without one counts what its body hands
out.

| Construct | Money and tokens | Time |
|---|---|---|
| sequence | sum | sum |
| `par` | sum | longest branch |
| `if` / `switch` | larger branch | larger branch |
| `loop max_iter n` | n × body | n × body |

The diagnostic's facts list each contribution. Currencies are never
converted (E0504). Loops need `max_iter` or `until`, and functions and
workflows cannot call each other in a cycle (E0502). A bodiless skill runs
as an agent loop and needs `steps` in the skill's or the agent's budget
(E0503). A workflow may expand to at most 1000 static nodes, with loops
unrolled to `max_iter` and called functions inlined (E0105).

## Contracts (§10)

A criterion satisfied only by `review(…)` is E0603. A `static` criterion
the compiler cannot prove becomes a run-time check and is reported as
W0601. Doc 4 Appendix B names this E0601 and says it falls back to a
warning.

## Supervision (§8.7)

`UnknownOutcome` can only be handled with `reconcile` (E0712, V06).
`restart_all` cannot restart branches with external effects (E0710).
`restart(max: n)` allows at most 5 retries (E0713). `spawn` is not
available in 0.1 (E0711).

A `par` block may be supervised by `fail_fast` or `restart_all`; a
delegation by `restart(max, backoff)`, `escalate(human)` (optionally with
`role: "…"`) or `degrade(to: F)`. Any other strategy is refused (E0714).
A fallback `F` must do the same job with no more authority (E0715):

- `F` has the same skill, with the same parameter and result types;
- every capability of `F` lies inside one of the original agent's;
- `F` holds what the call hands over with `with caps`.

A delegation's `timeout` must be a `Duration`.
