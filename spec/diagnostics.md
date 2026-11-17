# Diagnostic codes

Diagnostics use the JSON shape of design doc 4 §13.1: a stable `code`, a
`message` for people, a location (`at.path` is a JSON Pointer into the
canonical IR, `at.span` is `[line, col, endLine, endCol]` in the input),
structured `facts`, and optional `repair` patches. Agents should read `code`,
`facts` and `repair`; `message` may change between versions.

Families follow doc 4 Appendix B. Inside E01xx the design names only E0101
and E0110, so the codes below marked *assigned* were chosen for this
implementation.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E0101 | Syntax error | — | Appendix B |
| MDT-E0102 | Duplicate JSON key | S01 | assigned |
| MDT-E0103 | Unsupported language version | S02 | assigned |
| MDT-E0104 | IR schema violation | S02 | assigned; unknown fields are errors; in 0.6 a value that matches more than one form the schema allows is too (`keyword: "oneOf"`: a delegation with both a slot and an `Agent.skill`, E0104e; a slot argument with both a value and a type, E0104f) |
| MDT-E0105 | Resource limit exceeded | P04 | assigned; limits from §3.4, including 1000 expanded nodes per workflow; in 0.6 the expansion of a pattern counts, and nests and copies no more than the reader allows (P04, "Patterns (0.6)" below) |
| MDT-E0106 | Number not representable | S11 | assigned |
| MDT-E0107 | Invalid Unicode | S11 | assigned |
| MDT-E0108 | Malformed JSON | E0108 | assigned |
| MDT-E0120 | Unresolved name | S03 | assigned; carries a repair when one close name exists |
| MDT-E0121 | Duplicate name | — | assigned |
| MDT-E0130 | Stale base | S12 | assigned |
| MDT-E0131 | Patch cannot be applied | — | assigned |
| MDT-E0140 | Malformed lock file | — | assigned; see [`lock.md`](lock.md) |
| MDT-E0141 | Model tier not locked | — | assigned; also refused at load time |
| MDT-E0142 | Imported module not locked | S09 | assigned; a loaded module whose hash differs from the lock's pin, or an import the lock does not pin; also refused at load time |

`mandate explain <code>` prints the explanation for each code.

## Static checks (Gate 1)

These run after name resolution (`mandate check`). Codes named in doc 4 keep
their meaning; the ones marked *assigned* fill gaps the design leaves open.
Warnings (`W…`) never make a check fail.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E0201 | Type mismatch | — | Appendix B |
| MDT-E0202 | Unknown field | — | assigned |
| MDT-E0203 | Missing field | — | assigned |
| MDT-E0204 | Not a Path | V20 | assigned; a text literal where a Path is expected must keep the Path rule (K68, [core.md](core.md#paths)) |
| MDT-E0210 | Inferred value where T is expected | V01, V08 | Appendix B |
| MDT-E0211 | Untrusted value where T is expected | — | assigned |
| MDT-E0212 | Verified against a different contract | — | Appendix B |
| MDT-E0213 | Protected type produced by a program | S08 | assigned |
| MDT-E0215 | Untrusted text in an instruction position | V02 | Appendix B |
| MDT-E0220 | Data class above what the model may receive | V04, E0220, E0220a, E0220b | Appendix B; under an envelope, also above its `spawn.max_class`, in the body, in a function it calls and in a skill it reaches |
| MDT-E0230 | Non-exhaustive switch | S05, V07 | Appendix B |
| MDT-E0231 | Switch on a raw decision | — | assigned |
| MDT-W0232 | Choice without an out-of-scope option | — | assigned |
| MDT-E0233 | Too many Choice options | E0233 | assigned |
| MDT-W0207 | peek on model output | — | assigned |
| MDT-E0301 | Capability not in scope | — | Appendix B |
| MDT-E0305 | Capability widened | — | Appendix B |
| MDT-W0310 | Unused capability | — | Appendix B; an envelope's capability is used by a delegation inside a function the body calls |
| MDT-W0311 | Policy and real use disagree (learning mode) | — | Appendix B |
| MDT-E0320 | Overlapping writes in par | V03, E0320a | Appendix B; also at a map with `par > 1` whose body can write under a capability the map does not hand per item (N03) |
| MDT-E0401 | Undeclared effect | — | Appendix B |
| MDT-E0402 | Unknown effect | — | assigned |
| MDT-E0403 | Missing idempotency | — | Appendix B |
| MDT-E0405 | Irreversible effect without human approval | — | Appendix B |
| MDT-E0408 | External write outside a workflow | S07 | Appendix B |
| MDT-E0501 | Child budgets exceed the parent | E0501a, E0501b | Appendix B; an envelope's budget is compared in `steps` and `agents` too, and so is a map's `budget` with its body |
| MDT-E0502 | Unbounded loop or recursion | S04, S06; 0.7: S04b | Appendix B; in 0.7 also a cycle that goes through a contract: a `verify` runs its contract's `require`, criteria and verifiers' arguments, which may call a function that verifies against it again (S04b, E1907b) |
| MDT-E0503 | Agent loop without a step limit | — | Appendix B |
| MDT-E0504 | Budget currency mismatch | — | assigned; also an agent budget in another currency than its tier's tariff |
| MDT-W0504 | Budget below the computed upper bound | — | Appendix B; needs the lock file |
| MDT-W0601 | Static criterion checked at run time | — | Appendix B names E0601 and says it falls back to a warning |
| MDT-E0603 | Criterion satisfied only by review | — | Appendix B |
| MDT-E0701 | Delegated authority not a subset | — | Appendix B |
| MDT-E0710 | restart_all over external effects | — | Appendix B |
| MDT-E0711 | Dynamic spawn | V05 | Appendix B |
| MDT-E0712 | UnknownOutcome restarted | V06 | Appendix B |
| MDT-E0713 | Too many restarts | — | assigned |
| MDT-E0714 | Unknown supervision strategy | — | assigned |
| MDT-E0715 | Fallback is not equivalent | — | assigned |

The runtime checks E0406 (commit without a matching authorization) and
E0407 (an authorization consumed twice) at commit, and S09 (an unlocked
module) at load; see [`runtime.md`](runtime.md). W0504 needs model tariffs,
so it is reported when a check is given the lock (`--lock`,
[`lock.md`](lock.md)).

## Target generation

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E0902 | Sandbox requirement cannot be enforced | G05 | Appendix B; raised by the sandbox adapter as `unsupported_sandbox_profile`, with one line per guarantee the host does not give; among them `credential <name> for <host>`, a binding the egress proxy does not hold or does not bind to that host ([`boundary.md`](boundary.md#sandbox-egress)) |
| MDT-E0903 | Executor binding does not fit | X01 | assigned; a lock binding that names a missing or remote agent, an agent without one tier, a model or effort the lock no longer maps, another API beta, or a profile that claims too much or leaves a guarantee out ([`executors.md`](executors.md)); also refused at load time |
| MDT-E0904 | Executor cannot hold the locked output limit | X02 | assigned; K80 |
| MDT-E0905 | Data class too high for the executor | X03 | assigned; K46 |
| MDT-E0906 | Agent cannot be written as an ACS policy | X05 | assigned; an unscoped capability or a non-USD spend budget (`mandate target acs`, K82) |
| MDT-W0907 | Guarantee not carried by the target | X05 | assigned; names what an ACS host alone does not give |

## System model and existing systems (0.3)

Design doc 9 adds definitions and checks for working, multi-repo systems
([`system.md`](system.md)). Appendix B has no family for them; E10xx is
assigned here.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1001 | Interface without exactly one provider | — | assigned |
| MDT-E1002 | Capability over a component or an environment cannot be opened | — | assigned; not a component, a path outside it, an undeclared command kind, narrowing a capability that stands for several commands, or env.deploy / env.migrate over something not an environment |
| MDT-E1003 | Component working copies overlap | — | assigned; C5 across components |
| MDT-E1004 | Read does not match its declaration | — | assigned; one SELECT, placeholders = parameters, scalar parameters (K43) |
| MDT-E1005 | Read above its environment's class | — | assigned |
| MDT-E1006 | Environment tier does not bind | — | assigned; an environment's `authorize` names an effect that is not critical. At run time the stronger of the tier and the runtime's policy applies |
| MDT-E1007 | Governance pattern not relative | — | assigned; a component's `governance` patterns are relative to its repository's root ([system.md](system.md#governance-class-files-k70)) |
| MDT-E1101 | Change set order breaks the interface graph | — | assigned; an additive change's provider lands first and is a member; no cycles |
| MDT-E1102 | Change set order does not list its members | — | assigned |
| MDT-E1103 | Breaking change in one change set | — | assigned; expand → migrate → contract |
| MDT-E1104 | Change set member is not a critical effect | — | assigned |
| MDT-E1105 | Change set without a verified plan | — | assigned |
| MDT-E1201 | Read not as declared | — | assigned; data.read of a declared read, its parameters by name, max_class |

## Envelopes and signed decisions (0.4)

Specified in [`envelope.md`](envelope.md). E15xx (roles and people) and
E17xx (envelopes) are assigned here, and `mandate explain` knows all of
them. `mandate check` reports E1501 to E1503, E1701 to E1704, E1707 and
E1708. E1705, E1706 and E1709 are about what a lead sends while a run is
going, a sub-program or an amendment: the runtime's checker reports them
to the lead, and the Notes column says so.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1501 | Role not declared | E1501, E1501a; 0.7: E1501c, E1501d | assigned; a role a 0.4 module names is a `role` definition; in 0.6 also one an expansion names (E1501a, at the application); in 0.7 a role a question names (a `role:` of `human.ask`, `human.approve`, `human(…)` or `supervise escalate`, an approval's `distinct_from:`) is also no name a parameter or a binding in scope has, which a run would read in its place (`shadowed_by`: `parameter` or `binding`, with `where` and `argument`; a review's roles are E1507's) |
| MDT-E1502 | Role not bound | E1502 | assigned; needs the lock; `unbound_role` at load time |
| MDT-E1503 | `distinct_from` without an earlier approval | E1503, H02 | assigned |
| MDT-E1701 | Malformed envelope | E1701, E1701a | assigned; `owner`, `caps` and a `budget` with `agents`, and no `caps` or `budget` of the workflow's own |
| MDT-E1702 | Unbounded map | E1702, E1702a | assigned; no `max` outside an envelope, or inside one around a body that starts no delegation; at run time a longer list is `Rejected(over_limit)` (N08) |
| MDT-E1703 | Map concurrency above the envelope | E1703 | assigned; `par k` above `spawn.max_concurrent`, at the map's `par` |
| MDT-E1704 | Envelope approval names a non-critical or uncovered effect | E1704, E1704a | assigned; an effect under `approve` is critical, and a capability of the envelope covers it |
| MDT-E1705 | Not allowed in a sub-program | N09, E1705, E1705a; E1705b to E1705d (0.7) | assigned; a definition a sub-program may not make, an envelope or a `plan` of its own, a workflow with parameters, or not exactly one workflow; in 0.7, a `stage`, a `report` or a workflow's `owner` the lead wrote (fact `construct`); returned to the lead, never to the run |
| MDT-E1706 | Sub-program does not fit the envelope | N01, N01a, N01b, E1706, E1706a, E1706b; 0.7: E1706c to E1706e | assigned; facts name the dimension (`capability`, `write_scope`, a budget dimension, `time`, `data_class`) with what was asked and what is left; returned to the lead, never to the run. In 0.7, under a run limited in `asks` (the room's `left.asks`), the sub-program's declared `asks`, or without one its static attention total, is what its admission reserves (`dimension: "asks"`, at its `budget/asks` or at the workflow), and one whose total is unbounded and that declares none does not fit (`asked: null`, `total: "unbounded"`); its budget need not name `asks` |
| MDT-E1707 | `plan` outside an envelope | E1707 | assigned; a `plan` anywhere but the body of a workflow with an envelope |
| MDT-E1708 | Person or critical effect in a map body | E1708, E1708a; 0.6: E1708b (allowed), E1708c to E1708l | assigned; a wait for a person in a map body or in a function it calls, a critical effect, a change set. In a program of 0.6 a critical effect there is a batch commit step, and allowed, when it is not irreversible, the workflow's envelope does not name it under `approve`, no environment asks a person to authorize it, its `idempotent_by` key reads the map's item, the map has no `par` above 1 and is in no other map's body, and it stands in a workflow's body; a change set there never is. Otherwise E1708 at the effect, its facts `condition` (`irreversible`, `envelope_approve` with `role`, `environment_authorize` with `environment` and `role`, `key`, `par`, `nested_map`, `change_set`, `workflow`) besides `map`, `kind` and `what`. A wait for a person, `human.review` included, is E1708 in a program of 0.6 as before (E1708l). A program of 0.1 to 0.5 keeps the rule and its message exactly |
| MDT-E1709 | Amendment narrows the envelope | N04, E1709, E1709a, E1709b, E1709c; 0.6: N11b, E1709d; 0.7: E1709e to E1709g | assigned; a capability left out, a budget dimension lowered, dropped or added, fewer delegations at once or a lower data class; facts name the dimension (`capability`, a budget dimension, `max_concurrent`, `max_class`) with what the envelope gave and what was asked; returned to the lead, never to the run. In 0.6 also a shape the envelope lists left out (one diagnostic a shape, with `shape`, at `/defs/<W>/envelope/shapes`), or `shapes` added to an envelope that had none (`was: null`): `dimension: "shapes"`, `was` and `asked` the lists. Adding a shape, or taking the list away, widens and is allowed (N11d, N11e). In 0.7 `asks` is a dimension of its own, lowered, dropped or added as a budget dimension is (`dimension: "asks"`) |

## The boundary (0.5)

Specified in [`boundary.md`](boundary.md). E18xx is assigned here.
`mandate check` reports E1801 and E1804, and E1802 and E1803 when it is
given the lock.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1801 | Unknown method | E1801, E1801a, E1801b | assigned; 0.5 only; `methods` of `net.https` is a non-empty list of bare names from GET, HEAD, POST, PUT, PATCH, DELETE. Facts: `found` (the name written, or null) and `expected` |
| MDT-E1802 | Credential bound outside the sandbox | E1802, E1802a, E1802b, E1802c | assigned; needs the lock; an `egress` binding names something other than a local agent, a remote agent, an agent bound to an executor, or a host none of the agent's `net.https` capabilities holds. Facts: `agent`, `reason` (`not_an_agent`, `remote`, `executor`, `host_not_held`), and for a host `host`, `credential` and `held`. The path is into the lock |
| MDT-E1803 | Lock field does not apply to the program's language | E1803 | assigned; needs the lock; `isolation` or `egress` in a lock packaged with a program of 0.1 to 0.4. Facts: `field`, `language`. The path is into the lock. Also refused at load (`load_verification_failed`) |
| MDT-E1804 | Imported method limit read without it | E1804, E1804a | assigned; a program of 0.1 to 0.4 that reaches, through an import, a `net.https` capability written with `methods` in a module of 0.5 or later; reported at the import. Facts: `definition`, `module`, `module_language`, `language`. Also refused at load (`load_verification_failed`) |

## Libraries (0.6)

Specified in [`library.md`](library.md). E16xx is assigned there. Language
0.6 is read by the Rust compiler alone, so these codes are in its table of
codes (`crates/mandate-ir/src/codes.rs`) and not in the TypeScript's, and
each has hand-written conformance cases of `mandate/0.6`. `mandate check`
reports them (E1605 to E1608 also `mandate add`, `upgrade` and `publish`, whose functions the compiler gives as doors); the runtime's check at load is to refuse a package with E1603
or E1604 (`load_verification_failed`).

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1601 | Malformed library | E1601, E1601a | 0.6 only; a library handed to the check, to `add`, `upgrade` or `publish` is malformed: its manifest has a problem (`manifest`, with the problem of `mandate-lib`), it has a reserved name (`std`, `std.…`: only the built-in `std.patterns` does), a file it lists was not handed in (`missing_file`) or one handed in is not listed (`unlisted_file`), a module does not load (`module_does_not_load`, with `codes`), is not written in 0.6 (`not_0_6`), is named outside the library or twice (the problems of `mandate-lib`), defines an `extern` (`extern`, with `module` and `name`), or does not check with the modules of its library and of the libraries it requires (`module_does_not_check`, with `codes`: an import of any other module is E1604 there); a version directory that holds another name or version (`directory_mismatch`) or a malformed `index.json` (`index`). A module's name is the name its text declares; its file's name says nothing of it. The path is `/libraries/<name>`. Facts: `library`, `problem` |
| MDT-E1602 | Definition not public | E1602, E1602d, E1602e; E1602b (allowed) | 0.6 only; a program or module of 0.6 names in a `use` list (path `/uses/<i>/names/<j>`) a definition of a module of 0.6 it is given that is not `pub`. A `use` list is the one place a program of 0.6 names a definition of a module that is not the standard library's: the module's path (`types.Order`, `acme.types.Order`) and its last segment (`types`) are no names, and are reported as the unknown name of their place, E0120 (E1602a, E1602c). A module names its own definitions, and a lead's sub-program its parent's, freely; every definition of a module of 0.1 to 0.5 may be named through the list. Facts: `name`, `module` |
| MDT-E1603 | 0.6 module imported by an earlier program | E1603, E1603a | a program or module of 0.1 to 0.5 imports a module written in 0.6 that the check is given; reported at the `use`, and not E1602 besides. Facts: `module`, `module_language`, `language` |
| MDT-E1604 | Import not closed | E1604, E1604c, E1604d, E1602c; E1604b (allowed); E1604a (E0120) | 0.6 only; a `use` names a module that is not `std` itself, `std.decision`, `std.patterns`, a module the check was given or a module of a library it reads, or a module but the standard library's without a list of names (an import that lists no names brings none); reported at the `use`. The built-in `std.patterns` (E1604a: a name of its list it does not define is E0120) and the modules of a library handed to the check, which the lock pins when the check has one, are known too. Facts: `module` |
| MDT-E1605 | Library does not match the lock | L01 | 0.6 only; with the lock: what the check is handed of a library is not the pin (`version_differs`, `digest_differs`, `module_hash_differs`, `module_missing`, `module_unlisted`), a library handed in or the built-in `std.patterns` imported that the lock does not pin (`not_pinned`), a pinned library not handed in (`not_found`), a module pinned by the lock's `modules` and a library (`pinned_twice`, at `/modules`), or a module given to the check with another text than its library's (`given_differs`); `upgrade` when the pinned version given is not the pin. A module a library pins is not E0142. A lock its schema refuses pins nothing and is reported as E0140 after the static checks; one the schema accepts and the reader of `mandate-lib` refuses is E0140 at `/libraries`. Facts: `problem`, `library`, and the pin's and the found values |
| MDT-E1606 | Library requirement not met | E1606 | 0.6 only; a library's `requires` names a library that is not pinned (`requirement_not_pinned`; without a lock, not handed in) or one pinned outside its range (`requirement_out_of_range`); `add` and `upgrade` find nothing within the range (`no_version`) or are given a range that is not one (`invalid_range`). The path is `/libraries/<name>`. Facts: `problem`, `library`, `requirement`, `range`, `pinned` |
| MDT-E1607 | Publication breaks the version rule | L03, L06; 0.7: L11 | 0.6 only; `publish`: a version already published (`already_published`), a version that is not a major one above the highest published version below it and against it widens the authority signature, removes a criterion or adds a waiver (`needs_major`, with `base`), or a version against which the lowest published version above it of the same MAJOR would do one of these (`next_needs_major`, with `next`). In 0.7 a change of a workflow's `owner` (`owner_changed`) needs a major version too (`changes_owner: true`, a fact given only then, L11). The path is `""`. Facts: `library`, `problem`, `version`, `widens_authority`, `removes_criterion`, `adds_waiver`, `changes_owner` |
| MDT-E1608 | Library within its waiting period or revoked | L04, L04a | 0.6 only; `add` and `upgrade`: every version within the range that would be resolved waits (`reason: waiting`, `available_from`, the day) or is revoked (`reason: revoked`); with the configuration, `mandate check` of a lock that pins a revoked digest (`problem: revoked`). The path is `/libraries/<name>`. Facts: `library`, `version` or `digest` |

Language 0.6 extends two codes of the front end. `///` lines (doc lines) are
E0101 wherever they document no definition (cases E0101 to E0101d, E0101g;
E0101f: before 0.6 they are comments), and `pub` before any definition but a
`fn` stays E0101 before 0.6 (E0101e). `pub` and `doc` in the IR of a program
of 0.1 to 0.5 are unknown fields, E0104 (E0104d). And in 0.6 a name a `use`
lists from a module that is not the standard
library's is the definition it names: used as what its kind is not (a
constant as a type, a type as the contract of `Verified`, a lower-case name
as a module path), it is the E0120 the program's own definition gets there
(cases E0120, E0120a, E0120b).

## Connectors (0.6)

Specified in [`library.md`](library.md#connectors). E14xx is assigned there.
As E16xx, these codes are the Rust compiler's alone, in its table of codes,
each with hand-written conformance cases of `mandate/0.6`. E1401 to E1406 are
reported by `mandate check`; E1407 and E1408 by `mandate check` with the lock.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1401 | Tool without a closed class | E1401, E1401a, E1401b | 0.6 only; a tool that is neither `read_only` nor of a write class, or both; a write tool without `critical`, `idempotency key` or `retry_class`, or with `retry_class read_only`; a key that names no `Text` parameter; `reconcile by` missing with `reconcilable`, given with another class, or naming no read-only tool of the connector with one `Text` parameter that returns `Untrusted<Option<T>>` for the write's `Receipt<T>`; a `compensation` that names no other write tool of the connector. Path `/defs/<connector>/tools/<tool>` or its member. Facts: `connector`, `tool`, `problem` (`neither`, `both`, `missing`, `idempotency_key`, `retry_class`, `reconcile_by_missing`, `reconcile_by_not_reconcilable`, `reconcile_by`, `compensation`) |
| MDT-E1402 | Malformed connector | E1402, E1402a, E1402b | 0.6 only; the server (`/defs/<c>/mcp`) is not one absolute `https://` URL of printable ASCII with a host name (spec/egress.md "Host names") and no user, password, port, query or fragment; no `version`; no `class`, or one that is not a data class (`/defs/<c>/class`); no tool (`/defs/<c>/tools`); a tool declared twice, refused by the parser at the second name, as a text that does not read. Facts: `connector`, `problem` (`url` with `reason`, `version`, `class`, `no_tool`, `duplicate_tool` with `tool`) |
| MDT-E1403 | Tool result of the wrong kind | E1403 | 0.6 only; a `read_only` tool that does not return `Untrusted<T>`, a write tool that does not return `Receipt<T>`; path `/defs/<c>/tools/<t>/returns`. Facts: `connector`, `tool`, `expected`, `found` |
| MDT-E1404 | Malformed `tool.call` | E1404 | 0.6 only; reported where the capability expression is evaluated: a first argument that is no connector the program defines or lists in a `use`, a tool the connector does not declare, an argument that is not a bare name or that has a name, no tool, or `.narrow(…)` of a `tool.call`. Such a `tool.call` stands for no capability. Facts: `problem` |
| MDT-E1405 | Tool called where it cannot be | E1405, E1405a, E1405b, E1405c, E1405d, E1405e | 0.6 only; a read-only tool through `effect`, a write tool as an expression, any tool in a `fn`, a contract, a skill's body, a constant, a handler or a workflow's `ensures` (the places typed in a workflow's frame without being its body are its `ensures` and its handlers); at the call. Facts: `connector`, `tool`, `problem` (`read_through_effect`, `write_as_expression`, or the kind of body: `fn`, `contract`, `skill`, `const`, `handler`, `ensures`) |
| MDT-E1406 | Agent holds a write tool | T02, E1406, E1406a, E1406b | 0.6 only; a `tool.call` that names a write tool in an agent's `caps` (at the capability), in a delegation's `with caps` (at it), or in a map's `with caps` when the map's body delegates, directly or through a function however deep (at the map's capability); the run-time `grant` door grants no write part of a `tool.call` either. Facts: `agent`, `capability`, `through` (`caps`, `with caps`, `map with caps`) |
| MDT-E1407 | Connector not bound in the lock | E1407, E1407a, E1407b | 0.6 only; needs the lock; a connector a `tool.call` capability of the program's workflows (their caps or their envelope's) or agents names has no `connectors.<module>.<connector>` entry (path `/connectors`), or its entry has no digest for one of the tools it declares (path `/connectors/<id>/tools`), or its `url`, where the credential goes, is not the URL the connector declares (path `/connectors/<id>/url`; `url` is required in the entry by `spec/lock-0.6.schema.json`, E0140 when missing). Facts: `connector`, `problem` (`no_entry`, `no_digest` with `tool`, `url` with `url` and `declared`). The path is into the lock |
| MDT-E1408 | Lock binds no connector of the package | E1408, E1408a, E1408b | 0.6 only; needs the lock; an entry names a connector that neither the program's module nor a module the program imports defines (path `/connectors/<id>`; a module the check is given that the program does not import is not of the package, E1408b), or a tool the connector does not declare (`/connectors/<id>/tools/<tool>`). Facts: `connector`, `problem` (`no_connector`, `no_tool` with `tool`). The path is into the lock |

Language 0.6 extends these codes for connectors. E0121: a definition named like a
built-in effect (`Tool`, `Model`, `Fs.Read` …, and `Tool.Write`), which would
decide what covers that effect (E0121, E0121a; E0121b: a program of 0.5 is read
as before); in 0.6 a `Tool` or `Tool.Write` use is covered by a `tool.call` part
alone. E0120: a tool a connector
does not declare, in a call (`/…/callee/name`) or as an effect's name, a
connector used as a value, and a tool named without a call; and a type name of a
tool's signature that the program does not have as the definition the
connector's module means by it (not imported, or a definition of the program's
own of that name), at each use: a call, a write's effect, a `tool.call`, an
agent's capability that holds the tool (E0120c, E0120d). Facts: `name`,
`expected: "type"`, `module`, `tool`. E0220: a tool
whose parameter or result types are classed above its connector's `class`, at
the tool in the module that declares it (E0220e), and at each use of an imported
one, since a module given to `check` is not checked with the program; an
argument of a tool's call of a class above its connector's `class` (at the
argument, T06), and a delegation whose agent holds tools of a connector and
receives data of a class above that connector's (at the delegation, T06a); an agent that holds a connector's read-only tools above the class its
model capability may receive (at the capability, E0220c), or a delegation whose
grant does so where the agent's own caps do not (at the delegation, E0220d);
the facts `data_class`, `allowed` and `connector`; in a sub-program, as for a
model, E1706 with `dimension: "data_class"` when the class comes from what
the lead received. E0301: in a program of 0.6 every capability of every
`requires caps` of an effect is compared by coverage, scope included (B12,
E0301a; E0301b holds a program of 0.5 to the first constructor alone), and a
write tool's effect, and a read-only tool's call, are covered only by a
`tool.call` that names that tool of that connector (T01, T01b). E0320: a
`tool.call` that lists a write tool is a write capability, so two branches of
a `par` that call one write tool overlap (E0320b). E0140: a connector's `template` in a lock of 0.6 that
does not hold `{secret}` exactly once (E0140c).

## Reviews and waivers (0.6)

Specified in [`library.md`](library.md#humanreview-and-waivers). E1504 to
E1508 extend E15xx (roles and people). As E14xx and E16xx, they are the Rust
compiler's alone, in its table of codes, each with hand-written conformance
cases of `mandate/0.6`, and `mandate check` reports them.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1504 | Waiver of a criterion a person approves | E1504, E1504a, E1504b | 0.6 only; a criterion with `waive by` whose method is, or includes through `and`, a call of `human.approve`, or calls a function of the program whose body holds one, itself or through the functions it calls (E1504b); at `/defs/<C>/accept/<k>/waive` (or `invariant`). Facts: `contract`, `criterion`, `waive` |
| MDT-E1505 | Waivable value reaches an irreversible effect | E1505 to E1505l | 0.6 only; an argument of an irreversible effect (declared `irreversible`, or `git.merge`, `deploy`, `migrate`) that may rest on a waiver: a value verified against a contract with a `waive by` criterion, or a value made of one (a `let` of any declared type, a field, what a function gives back of it or verifies itself, a map's item, an element of a review's `accepted`, and each value a form of 0.6 may be: a later arm of a `switch`, `pause and x`, a block that ends with a `let`, an `if` or a `loop`, E1505h to E1505l), or one whose type names such a contract (`Verified<T, C>`, `Review<T, C>`, in its arguments or fields); at the argument. Such a value does not stand for the approval E0405 asks for either (E1505f: E1505 and E0405). The same for an argument of an irreversible member of a change set, and for the plan of a change set that has one. Facts: `effect`, and `contract` when the value's type names it |
| MDT-E1506 | Review of a list that is not a verifying map's | E1506 to E1506i | 0.6 only; the first argument of `human.review` is not a name that a `let` of the same workflow body binds, as the last binding of it, to a `map` whose body ends with `verify x against C(…)` with no `on unmet`, and after which no `on error` handler gives a value of its own (E1506i); at the argument, or at the call when it has none or stands outside a workflow's body. Facts: `problem` (`missing`, `outside_workflow`, `not_a_name`, `not_let`, `not_a_map`, `not_verifying`, `on_unmet`, `returns`, `on_error`), `source` (the name, when there is one) |
| MDT-E1507 | Malformed review | E1507 to E1507i | 0.6 only; an argument of `human.review` after its results: a second one without a name, one it does not take, one given twice, `role` or `escalate_to` that names no role definition, `escalate_to` that names `role`'s role, a `deadline` that is not a duration literal above zero or a constant whose value is one; at the argument, or at the call for `role` or `deadline` missing. Facts: `problem` (`positional`, `unknown_argument`, `repeated`, `missing`, `not_a_role`, `same_role`, `deadline`), `argument` |
| MDT-E1508 | Review role cannot waive | H07, E1508, E1508a | 0.6 only; the review's `role`, or its `escalate_to`, is not among the `waive by` roles of a criterion of the contract its source verifies against (at the argument; facts `problem: "cannot_waive"`, `role`, `contract`, `criteria`), or that contract has no criterion with `waive by` (at the call; `problem: "no_waiver"`, `contract`) |

A role a `waive by` names is a role definition, E1501, as every place that
names a role, and with the lock it is held by a member, E1502.
`Review<T, C>` and `Declined<T>` are built-in types of a program of 0.6 (in
an earlier program they name nothing, E0120), whose `C` is a contract as
`Verified`'s is (E0120 otherwise), and which only the runtime makes: a
record literal of either (or of an alias of one), a model's answer, a
skill's, host code's or a declared effect's result that holds one, in its
arguments, its fields or the type definitions it names (an alias, a record,
a union's variants), is E0213 (E0213a to E0213f). No definition of a program, a module or a sub-program
of 0.6 takes either name, and no `use` list brings one of that name from
another module: E0121, at the definition or the listed name, with the facts
`name` and `builtin: "type"` (E0121c, E0121d), so that what types a review
is the language's alone. Nor does one take the root of a standard module
(`component`, `data`, `decision`, `env`, `exec`, `fs`, `git`, `human`,
`model`, `money`, `net`, `test`, `time`, `tool`), whether the program imports
it or not: E0121 with `builtin: "module"` (E0121e, a connector named `human`;
E0121f, a listed name), so that a call written `human.review(…)` is the
standard library's, as the runtime reads a call by its path. A `human.review` is a `human.*` step, so E1708 in
a map's body (E1708l).

In a program of 0.6 each form is typed as the runtime evaluates it, and the
codes of the front end hold what that gives. Where the runtime gives one of
several values the type is their join (the weaker level, a contract only when
both name it, the higher class, resting on a waiver when either does, and of
two types one of which holds an unknown the other's, as `[]` joins any list,
E0201e, or none when that unknown is silent): the
arms of a `switch` (E1505h, E0210b, E0220f), a statement and the `on error`
handler after it (E0210c; a supervision strategy there gives no value), a
`verify` and its `on unmet` handler (E0210d, E0201a), the branches of an `if`
(E0210e), and a block has the value of its last statement, a `let`, an `if`
or a `loop` included (E1505j to E1505l), which a function's declared return
type holds as it holds an expression (E0201b, at the statement). The one
exception: a `verify` whose `on unmet` handler is nothing but `escalate …` or
`pause` keeps the verified value's type, as in 0.5 (H08), for the runtime
refuses the person's answer at a `Verified` parameter. `pause and x` is `x`
(E1505i); `x?` of what is not a `Result` is `x`, its contract kept (E0212); a
person's answer (`escalate`, `pause` alone) and what an `on error` pattern
binds are `Untrusted`, of the highest class. A call is of a function of the
program, a standard function under its module's name, a connector's tool, a
decision policy, `quote`, `len`, `peek` or `human.review`, as the runtime
calls nothing else: any other is E0120 at its callee, with the facts `name`
and `expected: "function"`, a member of a value (`x.m()`, E0120f), a
standard function whose module's name a variable takes (`let human = …;
human.ask(…)`, E0120e), a workflow or an extern (E0120g); not a criterion's
own method, a constant's call or a supervision strategy. `await` is E0711
(E0711). An effect in a workflow's `ensures`, which states what holds once
the run is done and does nothing, is E0408 at the effect, with the facts
`effect` and `place: "ensures"` (E0408b; a tool there is E1405). A value of a form the checker still cannot type, of which no
diagnostic already stands for the unknown (a field of a type it sees no
fields of, a range, the result of a standard effect the table does not
type, a constant on a cycle, a name the runtime gives as itself, what
`peek` gives of such a value, E0201d), is never accepted where a verified
value is required: E0201, at that place. A record's field declared
`Verified` takes only a verified value, as the record holds what it is
given: E0201 (or E0210, E0211, E0212) at the field (E0201c). A program
of 0.1 to 0.5 is typed as before.

## Patterns (0.6)

Specified in [`library.md`](library.md#patterns). E13xx is assigned there.
As E14xx and E16xx, these codes are the Rust compiler's alone, in its table
of codes, each with hand-written conformance cases of `mandate/0.6`, and
`mandate check` reports them. A pattern the program defines is checked on its
own for E1301, E1302, E1306 and E1307 (at paths into it); one a `use` list
brings from a module is checked again where it is applied, each diagnostic at
the application (`/defs/<W>/apply`) with `module` and `pattern_path` in its
facts. Such a pattern's names resolve in its module, which must itself
resolve: a name it does not know is E1302 when the applying program's
definition of that name would bring authority into the expansion, and E0120
otherwise, and a name of another of its definitions that resolves to
nothing is E0120 with `module_path`, each at the application; no name of an
imported pattern is ever read as the applying program's but through a slot's
argument. Every check after these runs on the expansion; a diagnostic it
finds is reported at the slot argument whose value its place is (with `slot`
and `expanded_path` in its facts), or at the application (with `pattern`,
`pattern_path` and `expanded_path`), and so is each place its facts name (the
parts of an E0501's `breakdown`). `check` gives the expanded program only for
a program that checks.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1301 | Malformed pattern | E1301 to E1301g | 0.6 only; a slot of a kind that is none of `type`, `skill`, `tool`, `effect`, `contract`, `role`, `capability`, `const`, `field` (`problem: "unknown_kind"`, at `/slots/<i>/kind`), two slots of one name (`slot_twice`), a type parameter named twice (`type_parameter_twice`), a signature its kind does not take (`signature`, with `missing` and `extra`), no body (`body`, at the pattern), a slot used other than its kind allows: a skill slot only delegated to, a tool slot only called (E1301g), an effect slot only run with `effect`, a contract slot only verified against or named in `Verified<T, C>`, a type slot only as a type, a const slot only as a value or as a map's `max` or `par` (`slot_use`, at the use), and a `slot` member on anything but a delegation (`slot_use`, with `use` its `op`); a delegation that names both its slot and an `agent` or a `skill`, which a module handed over as IR may carry though the reader refuses it (`slot_beside`, with `beside`). Facts: `pattern`, `problem`, `slot`, `kind` |
| MDT-E1302 | Pattern brings authority | P03, P03a, E1302 to E1302j | 0.6 only; the pattern declares `caps`, a `budget` or an `envelope` (`declares`, at the member), or names, other than through a slot, a capability (by name, or a constructor in a `with caps`, E1302i, or one that is no function of the standard library anywhere), an agent, a connector or its tool, an effect run with `effect`, a role (by name, or as text where a person is asked, E1302g), a workflow or an `extern`, directly or through a function (through two, E1302h), constant, type or contract of its module that names one (a contract whose criterion a person may waive, E1302j) (`via`); at the place. An imported pattern that names what its module does not know and the applying program defines with such authority (at the application, with `module` and `pattern_path`). Facts: `pattern`, `names`, `name`, `via` |
| MDT-E1303 | Not a pattern | E1303, E1303a | 0.6 only; `workflow W = P<…>(…)` where `P` is no definition of the program and no name a `use` list brings from a module the check was given, or one of another kind (`kind`); at `/defs/<W>/apply/pattern`. A pattern of another module that is not `pub` is E1602 at the `use` (E1602d). Facts: `workflow`, `pattern`, `kind`, `module` |
| MDT-E1304 | Slots and arguments do not match | E1304 to E1304m | 0.6 only; a slot without an argument (`missing`, at `/apply/args`), an argument for no slot (`no_slot`) or given twice (`twice`, at the name), another number of type arguments (`type_arguments`, with `expected` and `given`), an argument of another kind than its slot's (`kind`, at the argument: a type, `Agent.skill`, a read-only tool `c.t` (a write tool given to a tool slot, E1304m), an effect or a write tool `c.t`, a contract, a role, a capability, a constant expression, a field's name). Facts: `pattern`, `problem`, `slot` |
| MDT-E1305 | Argument does not fit its slot | E1305 to E1305j; L09 (allowed) | 0.6 only; at the argument: another number of parameters (`arity`), a slot's parameter type its argument does not accept (`parameter`, with `index`, `slot_type`, `argument_type`), an argument's result the slot's does not accept (`result`), a constant of another type (`type`) or that is none (`not_constant`); a list, set or record literal, or a named constant that is one, given to a `const` slot of a list, set or record type, held to it part by part (`type`, with `why`: an item, a field missing or extra, a name that is no constant, so that a value slot brings no authority, E1305i, E1305j), a constant a map's `max` or `par` reads that is not a whole number of at least 1 (`count`), a field the record type does not have (`field`), a `read_only` skill slot given the skill of an agent that holds a write capability (`read_only`, with `agent` and `capability`). A tool's `Verified<T>` accepts a `Verified<T, C>`, and a write tool's `idempotency key` parameter is no part of its signature (P02). Facts: `pattern`, `problem`, `slot` |
| MDT-E1306 | Name collision in a pattern | E1306 to E1306e | 0.6 only; a slot, type parameter or run parameter named like another of them (`twice`, with `kinds`), or like a definition the pattern's module defines or imports (`module_name`); a name the body binds (a `let`, a `par` branch, a map's item, `on unmet`, a case's names) that is a slot's, a type parameter's or a run parameter's (`local`, at the binding); at an application, an argument that names what the body binds around the slot's use (`captured`, at the argument), and a definition of an imported pattern's module or a module of the standard library that the expansion names and that the applying program defines or imports from elsewhere (`taken`, at the application). Facts: `pattern`, `problem`, `name` |
| MDT-E1307 | Nested or misplaced application | E1307 to E1307e; 0.7: E1307f | 0.6 only; a workflow that applies a pattern and has an `envelope`, parameters, a result, a body, `ensures` or handlers of its own (`member`, at the member); a pattern called or named as a value in a body, a constant or a capability (`call`, `value`), in a pattern's body (`in_pattern`), or given as a slot's argument (`argument`); a workflow the static checks meet unexpanded (`unexpanded`, which a program that checked never has). Facts: `problem`, `applies` |

Language 0.6 extends five codes for patterns. E0104: the IR of 0.6 refuses a
value that matches two of its forms (E0104e, E0104f). E0105: the expanded
body of a workflow counts toward its 1000 static nodes (P04, at the
application), and an expansion that nests an argument deeper than 64 levels,
or copies more than 1 MiB of arguments, is refused at the argument or the
application; the expansion stops at the copy that passes the limit (`copied`,
at most the limit and one argument). E1602: an imported pattern whose
expansion names a definition of its module that is not `pub`, or one its
module imports, at the application (E1602e). E0120: `delegate s(…)` and a
map's `max s` or `par s` stand only in a pattern's body, for one of its
slots; and a name an imported pattern's module does not know (above). And
every rule holds inside an expansion as if its body were written out (E1708n,
E1708o, E1505m, E1506j, E1501a, E0301d, E0220g, E0210).

## Shapes (0.6)

Specified in [`library.md`](library.md#shapes). E1710 and E1711 extend E17xx
(envelopes). As E13xx, they are the Rust compiler's alone, in its table of
codes, each with hand-written conformance cases of `mandate/0.6`. `mandate
check` reports E1711; E1710 is about what a lead sends while a run is going,
and the runtime's checker reports it to the lead, as E1705.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1710 | Sub-program is not one of the envelope's shapes | N11, E1710, E1710a, E1710b; N11c (admitted) | 0.6 only; the envelope has `shapes` and the sub-program's one workflow is written out (`not_an_application`, at `/defs/<W>`), applies a pattern the list does not name (`not_listed`), or applies under a listed name a definition other than the pattern the parent lists, such as one of its own (`other_definition`, with `module` and `shape_module`), each at `/defs/<W>/apply/pattern`. Checked after E1705 and before the rest of the sub-program; an admitted sub-program's result names its `shape` (`{ pattern, module }`). Its containment in the envelope (E1706) is proven over the expansion. Facts: `workflow`, `problem`, `pattern`, `shapes`; returned to the lead, never to the run |
| MDT-E1711 | Shape is not a pattern | N11a, E1711, E1711a | 0.6 only; a name an envelope's `shapes` lists is no definition of the program and no name a `use` list brings (`kind: null`), or one of another kind (`kind`, and `module` when imported); at `/defs/<W>/envelope/shapes/<i>`. A list that is empty or names one pattern twice is refused when it is read: E0104 in IR (a set of names, as `waive`), E0101 for `shapes []` and E0121 at the second name in the text. Facts: `workflow`, `shape`, `kind`, `module` |

A program of 0.1 to 0.5 has no `shapes`: in its text the word is no field of an
envelope (E0101), and in its IR an unknown member (E0104, case E0104g).

## Reserved method names (0.7)

Specified in [`attention.md`](attention.md#static-rules). E1509 extends E15xx
(roles and people). As E1504 to E1508, it is the Rust compiler's alone, in its
table of codes, with hand-written conformance cases of `mandate/0.7`.

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1509 | Criterion method name reserved | E1509, E1509a, E1509b | 0.7 only; a criterion of a contract whose verifier is, or has among its `and` parts, a call whose callee path is exactly `verify` or `waiver`, the names the runtime writes its own evidence records under and refuses at load (`reserved_method`); at `/defs/<C>/accept/<k>/by` (or `invariant`), once per criterion. A callee path that only ends so (`test.verify`, E1509b) and a `static` part are not it. A program of 0.6 has no such check: it checks, and the runtime refuses it at load (`crates/mandate-check/tests/reserved_methods.rs`). It is reported in the module that writes the contract, when that module is of 0.7; a 0.7 program that imports such a contract from an older module is still refused at load (`reserved_method`). Facts: `contract`, `criterion`, `method` |

## Attention (0.7)

Specified in [`attention.md`](attention.md#static-rules). E19xx is assigned
there. As E13xx, these codes are the Rust compiler's alone, in its table of
codes (`CODES_0_7`), each with hand-written conformance cases of
`mandate/0.7`, and `mandate check` reports them. The stages are checked after
the shapes of an envelope, on the program as written (its workflows written
out, its patterns, and every other place a stage might stand), and again on
what an expansion writes: a workflow that applies a pattern has the pattern's
stages, and a diagnostic of its expansion is reported at the application
(`/defs/<W>/apply`, with `pattern_path` and `expanded_path`). A stage adds no
cost, node, value, scope, role or authority, so no other code changes for it
but in its paths: the statements after a stage have a higher index. The
reports are checked after the stages, in the same two places; a report's
field is typed by the static checks, which hold its type (E1904,
`problem: "type"`). A report adds no cost, node, value, scope or authority;
its role is a role site (E1501, E1501b; with a lock E1502, E1502a).

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1901 | Stage out of place | E1901, E1901a, E1901b | 0.7 only; a `stage` that is not a top-level statement of a workflow's body (written out) or of a pattern's body: in a block, a branch, a loop, a map's body or another member of a workflow or a pattern (`place: "nested"`), or in a definition of another kind or a test (`place` its kind, or `test`); at the stage. Facts: `stage`, `place` |
| MDT-E1902 | Malformed stage list | E1902 to E1902g | 0.7 only; of the top level of one body: a stage named like an earlier one (`duplicate`, at its `name`), a statement before the first stage of a body that has stages (`before_first`, at `body/0`), a stage directly before another or at the end (`empty`) and one directly before `on error` (`on_error`), each at the stage, and a title with a control (`rule: "control"`), a format or bidirectional character (`rule: "format"`, Unicode's category Cf), or a line or paragraph separator (`rule: "separator"`, U+2028 and U+2029, E1902g), with `char` its code point, at its `title`. A title's length (1 to 80 code points) is held by the schema of 0.7 (E0104, E0104i and E0104j) and its interpolation by the parser (E0101, E0101h). Facts: `workflow` or `pattern`, `stage`, `problem`, `rule`, `char` |
| MDT-E1903 | Malformed report | E1903 to E1903e | 0.7 only; a `report` whose title breaks the title rules of a stage's (`problem: "title"`, `rule` `control`, `format` or `separator`, `char`, at its `title`), with two fields of one name in IR (`duplicate_field`, `field`, at the second's `name`; the text refuses the same as E0121, E0121g), or in a pattern addressed to a name that is not one of the pattern's role slots (`role`, `pattern`, `slots`, at its `role`). Its title's length and its number of fields (1 to 16) are held by the schema of 0.7 (E0104, E0104l to E0104o), and its title's interpolation by the parser (E0101, E0101i). Facts: `role`, `problem` and the problem's own |
| MDT-E1904 | Report field not shown | E1904 to E1904v | 0.7 only; a report's field that is not pure (`problem: "impure"`, `what` the kind of expression, `callee` for a call, at the part that is not: a delegation, spawn, await, inference, verification, effect, change set, map, plan, escalation, pause, `try`, block, or any call but the built-in `len`, `human.*`, a tool's and a function's among them), or whose type the typing gives is not one a person is shown (`problem: "type"`, `type`, at the field's value: not a scalar, an enum, an `Option` or a `List` of one, or a record of these one level deep, each optionally `Verified`, `Inferred` or `Untrusted`, or a type the check does not know). On an expansion, at the application (E1904v). Facts: `role`, `field`, `problem`, `what`, `callee`, `type` |
| MDT-E1905 | Report out of place | E1905 to E1905g | 0.7 only; a `report` in a map's body (`place: "map"`), a loop without `max_iter` (`loop`), an `on error`, `on unmet` or `on budget_exceeded` handler (`on_error`, `on_unmet`, `on_budget_exceeded`), a function or a definition of another kind (its kind), a test (`test`), a member of a workflow or a pattern other than its body (the member), or directly before an `on error` (`before_on_error`: a report changes no value of the run, and the handler would handle the statement before it); at the report. A `stage` or a `report` written in a lead's sub-program is E1705 instead (`construct`, E1705b, E1705c), and one a listed shape's expansion brings is not (A03). Facts: `role`, `title`, `place` |
| MDT-E1906 | Attention above `asks` | E1906 to E1906p | 0.7 only; the attention bound of a workflow (spec/attention.md "The attention bound": the questions one run can put to people, each kind of site counted as its table says, summed over a sequence and a `par`, the larger branch of an `if` or a `switch`, times a loop's `max_iter`, a function's at each call, a statement's and its handler's) is above the `asks` its budget or its envelope's declares; at the `asks` (`/defs/<W>/budget/asks` or `/defs/<W>/envelope/budget/asks`). A mutation for each kind of site (E1906a to E1906j) and each part of the algebra (E1906k to E1906p). Facts: `workflow`, `asks`, `total`, `roles` (each `{ role, questions }`) |
| MDT-E1907 | Attention without a bound | E1907 to E1907b | 0.7 only; the workflow declares `asks` and a question stands where the bound cannot count it: in a loop without `max_iter` (`why: "loop"`), in what a cycle of calls reaches, through a function that calls itself or through a contract's `require` (`recursion`, beside E0502, E1907a, E1907b), or more times than a count holds (`overflow`); at the question (at the workflow's `asks` for an overflow of the total alone). A workflow without `asks` may ask without a bound: no diagnostic, and its facts say `unbounded`. Facts: `workflow`, `kind`, `why`, `asks` |
| MDT-E1908 | `asks` out of place | E1908 to E1908e | 0.7 only; `asks` in a budget that is neither a workflow's (`/defs/<W>/budget`) nor an envelope's (`/defs/<W>/envelope/budget`): an agent's (`place: "agent"`), a skill's, a function's, a delegation's, a map's or a plan's (`skill`, `fn`, `delegate`, `map`, `plan`), at the field. A program of 0.1 to 0.6 has no `asks`: in its text it is an unknown budget field (E0101), in its IR a member its schema does not have (E0104). Facts: `def`, `place` |
| MDT-E1910 | Owner misplaced or missing | E1910 to E1910b | 0.7 only; the `owner` of a workflow written out beside an envelope, whose `owner` has that place (`problem: "with_envelope"`, `owner` the role it names, at `/defs/<W>/owner`, E1910; an application with an envelope is E1307 alone, E1307f); with a lock whose `promotion` is `"required"`, a workflow of the program with neither an `owner` nor an envelope, which nobody could promote (`problem: "no_owner"`, at `/defs/<W>`, the application itself for one that applies a pattern, E1910a, E1910b). What an `owner` names is a role site (E1501, E1501d; with a lock E1502, E1502b), and one a lead writes in its sub-program is E1705 (`construct: "owner"`, E1705d). Facts: `workflow`, `problem`, `owner` |
| MDT-E1911 | Lock field of a newer language | E1911, E1911a | 0.7 lock only; needs the lock; `role_classes` (E1911) or `promotion` (E1911a) in a lock of format 0.7 packaged with a program of 0.1 to 0.6, whose runs mask nothing and climb no ladder, at the field (`/role_classes`, `/promotion`): refused rather than dropped silently, as E1803. In a lock of an older format each is E0140 at the lock's root (E0140e, E0140f); a class for a role `roles` does not name is E0140 at its entry (E0140g), and a class that is none is the schema's (E0140h). Facts: `field`, `language`. The path is into the lock |

A program of 0.1 to 0.6 has no `stage` and no `report`: in its text the line
is ordinary names (A01b, A02b), and in its IR a statement its schema does not
have (E0104, E0104h, E0104k).

## Newer modules (0.7)

Specified in [`attention.md`](attention.md#stdpatterns-200). E1609 extends
E16xx, the family of libraries, and is a code of 0.7 (`CODES_0_7`), with
hand-written conformance cases of `mandate/0.6` and `mandate/0.7`: what it
refuses is a program of 0.6 that reads what 0.7 wrote. `mandate check`
reports it; the runtime's check at load refuses such a package
(`load_verification_failed`).

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1609 | Module of a newer language | E1609, E1609a; E1609b, E1609c (allowed); E1603b (E1603) | a program of 0.6 or later imports a module written in a newer language than its own (a module given to the check, a library's, or the built-in `std.patterns` 2.0.0), at the `use` (facts `module`, `module_language`, `language`), and not E1602 besides; or its lock pins a library written in a newer language, the language of its newest module, at `/libraries/<name>` (facts `library`, `version`, `library_language`, `language`). A 0.6 program whose lock pins `std.patterns` 2.0.0 and imports it has both (E1609). A 0.7 program reads a module of 0.6 (E1609b), and one whose lock pins `std.patterns` 1.0.0 reads 1.0.0, with no stage (E1609c). A program of 0.1 to 0.5 that imports a module of 0.6 or 0.7 stays E1603 (E1603b) |
