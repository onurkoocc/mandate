# Mandate

Mandate is a language in which a person states what an AI agent may do and
what counts as proof. A compiler and a runtime enforce it. Agents write and
edit programs; people review them through generated views; the compiler
checks capabilities, effects, budgets, contracts and delegation before
anything runs. This repository holds the reference implementation of
versions 0.1 to 0.7.

## Why

Agents now act on real systems: they open pull requests, change customer
records, spend money. They work faster and at a larger volume than any
person can review. Most agent frameworks describe what an agent does. Few
can show, before the first token is spent, what it is allowed to do.

Mandate moves the person's part to a scale a person can keep. The person
writes and signs what they want, what they allow and what counts as proof,
in a few lines they can read. The system enforces that statement
independently of the agent's skill, and the result is checked by something
other than the agent. In short:

- Every write, command, network target and model call is declared, and
  budgets are reserved up front.
- Acceptance criteria are met by evidence bound to the exact bytes it
  checked, never by an agent's statement.
- People take part as typed steps with a role and a deadline; a missed
  deadline escalates, it never passes.
- Restricted data cannot reach a model that may not receive it.
- A journal and reconciliation of unknown outcomes replace blind retries.

## Who it is for

The target of 1.0 is one person, one agent, one job. The person delegates a
job to their own agent, understands from the card what authority they gave,
and verifies the result with evidence bound to the same contract. Inside
the authority granted, the agent chooses its own method and tools; the
person is asked when their decision changes the outcome.

The first user group is not chosen yet. Two proposed pilots are meant to decide it: a team adding
the contract to its existing coding agent, and an operations team handling
invoice exceptions.

## Invariants

Only the product owner changes these.

1. An agent writes and edits programs, but no tool lets it sign, approve or promote; those are a person's, made with their own key ([`spec/mcp.md`](spec/mcp.md#07), [`spec/attention.md`](spec/attention.md#the-mcp-server)). That key is not always required today. Where the runtime's configuration turns on unsigned mode, in a run of a package whose program and every module packaged with it are written in 0.1 to 0.3, an approval, a decline or an answer at a wait and a raise of the run's limits may be taken unsigned, on the name the caller gives, and a reconciliation may be asked with neither key nor name ([`spec/envelope.md`](spec/envelope.md#signed-decisions)). A cancel needs no signature, in either mode and for any package: stopping a run needs nobody's authority. A decision taken unsigned stays unsigned, and where decisions are signed an approval that names no signed decision is not evidence.
2. Authority handed to a sub-agent only narrows: a program cannot create authority and nothing widens a capability ([`spec/core.md`](spec/core.md#4-capabilities)).
3. A review alone meets no criterion, and evidence is produced by the verifier, never by the agent ([`spec/core.md`](spec/core.md#6-contracts-and-evidence)).
4. An irreversible effect needs a person's approval, and no model or program can authorize an effect ([`spec/core.md`](spec/core.md#3-effects), [`spec/core.md`](spec/core.md#72-external-effects-prepare--authorize--commit)).
5. A person's approval is a signed decision bound to the hash of the package it was given for, so it does not hold for a changed package; a running run's package changes only by an amendment signed by the envelope's owner ([`spec/attention.md`](spec/attention.md#card-approval), [`spec/envelope.md`](spec/envelope.md#invariants)). An approval taken on the name the caller gives, as invariant 1 allows, is not signed; a card approval, an amendment and a promotion always are.
6. The system enforces the limits, not the model's cooperation: an unsupported security requirement is never dropped silently, and a host that cannot enforce a sandbox does not start the agent ([`spec/core.md`](spec/core.md#8-invariants), [`spec/sandbox.md`](spec/sandbox.md#running-agents-in-sandboxes)).
7. A run's journal is tamper-evident, and a verifier that reads only the export and public keys can check it ([`spec/journal.md`](spec/journal.md#verification)). One exception holds today: the journal events of a run begun before the chain carry no chain hashes and no anchor covers them ([`spec/journal.md`](spec/journal.md#which-runs-are-chained)), so its journal gives no tamper evidence, and the verifier reports it as `unchained`, which says nothing either way. The evidence has other limits, listed in [`spec/journal.md`](spec/journal.md#what-it-proves-and-what-it-does-not).

## Roadmap

Versions 0.1 to 0.7 are implemented ([Status](docs/REFERENCE.md#status)); 0.7's live session, held by the project's owner with a simulated agent, is recorded in part: four of its eight criteria passed and four are open ([`spec/attention.md`](spec/attention.md#acceptance)). The proposed plan from here, in order; a release closes on the evidence in the last column.

| Release | What it delivers | Closes on |
|---|---|---|
| 0.8 | Decision correctness, recovery and stopping: what the person signs is what runs, and a repeated start, an interruption or a stop is handled without a duplicate or lost external action. | The card, the signature and the run state the same authority. Repeated start, interruption and stop experiments show the expected number of external actions and an equivalent result from the record. |
| Pilots | Two pilots choose the first user group, the first job and the support promise. | A decision based on the pilots' evidence. |
| 0.9 | The chosen profile is installable and operable. | Records of a clean install, an upgrade, a restore, a real integration and portability. |
| 1.0 | The target team completes end-to-end acceptance on the distributed artifact. | The team's acceptance, with the release decisions on record. |
| After 1.0 | Many runs, many agents, self-improving loops and more environments. | Acceptance cases for each guarantee a topic announces, before it enters the plan. |

The human gates, not production speed, set the calendar. Release numbers name product deliveries; the language, lock and signature formats are versioned separately, and only when their contract changes.

## Documentation

- [`spec/`](spec/): the normative language and runtime specification.
- [`docs/REFERENCE.md`](docs/REFERENCE.md): the status of each version ([Status](docs/REFERENCE.md#status)), the repository ([Layout](docs/REFERENCE.md#layout), [Rust](docs/REFERENCE.md#rust)), building and using the compiler ([Using the compiler](docs/REFERENCE.md#using-the-compiler)), [Conformance](docs/REFERENCE.md#conformance), the [Runtime](docs/REFERENCE.md#runtime) and [Live runs](docs/REFERENCE.md#live-runs).
- [`conformance/`](conformance/): language-independent rules, one case per rule.
- [`vectors/`](vectors/): exact expected outputs.

Working documents (vision, workflow, backlog, history, architecture,
operations) are kept locally under `work/` and are not part of the
repository.

## License

Apache License 2.0. See [`LICENSE`](LICENSE).
