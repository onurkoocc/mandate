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
| MDT-E0104 | IR schema violation | S02 | assigned; unknown fields are errors |
| MDT-E0105 | Resource limit exceeded | — | assigned; limits from §3.4, including 1000 expanded nodes per workflow |
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
| MDT-E0502 | Unbounded loop or recursion | S04, S06 | Appendix B |
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
| MDT-E1501 | Role not declared | E1501 | assigned; a role a 0.4 module names is a `role` definition |
| MDT-E1502 | Role not bound | E1502 | assigned; needs the lock; `unbound_role` at load time |
| MDT-E1503 | `distinct_from` without an earlier approval | E1503, H02 | assigned |
| MDT-E1701 | Malformed envelope | E1701, E1701a | assigned; `owner`, `caps` and a `budget` with `agents`, and no `caps` or `budget` of the workflow's own |
| MDT-E1702 | Unbounded map | E1702, E1702a | assigned; no `max` outside an envelope, or inside one around a body that starts no delegation; at run time a longer list is `Rejected(over_limit)` (N08) |
| MDT-E1703 | Map concurrency above the envelope | E1703 | assigned; `par k` above `spawn.max_concurrent`, at the map's `par` |
| MDT-E1704 | Envelope approval names a non-critical or uncovered effect | E1704, E1704a | assigned; an effect under `approve` is critical, and a capability of the envelope covers it |
| MDT-E1705 | Not allowed in a sub-program | N09, E1705, E1705a | assigned; a definition a sub-program may not make, an envelope or a `plan` of its own, a workflow with parameters, or not exactly one workflow; returned to the lead, never to the run |
| MDT-E1706 | Sub-program does not fit the envelope | N01, N01a, N01b, E1706, E1706a, E1706b | assigned; facts name the dimension (`capability`, `write_scope`, a budget dimension, `time`, `data_class`) with what was asked and what is left; returned to the lead, never to the run |
| MDT-E1707 | `plan` outside an envelope | E1707 | assigned; a `plan` anywhere but the body of a workflow with an envelope |
| MDT-E1708 | Person or critical effect in a map body | E1708, E1708a | assigned; a wait for a person in a map body or in a function it calls, a critical effect, a change set |
| MDT-E1709 | Amendment narrows the envelope | N04, E1709, E1709a, E1709b, E1709c | assigned; a capability left out, a budget dimension lowered, dropped or added, fewer delegations at once or a lower data class; facts name the dimension (`capability`, a budget dimension, `max_concurrent`, `max_class`) with what the envelope gave and what was asked; returned to the lead, never to the run |

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
reports them; the runtime's check at load is to refuse a package with E1603
or E1604 (`load_verification_failed`).

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E1602 | Definition not public | E1602; E1602b (allowed) | 0.6 only; a program or module of 0.6 names in a `use` list (path `/uses/<i>/names/<j>`) a definition of a module of 0.6 it is given that is not `pub`. A `use` list is the one place a program of 0.6 names a definition of a module that is not the standard library's: the module's path (`types.Order`, `acme.types.Order`) and its last segment (`types`) are no names, and are reported as the unknown name of their place, E0120 (E1602a, E1602c). A module names its own definitions, and a lead's sub-program its parent's, freely; every definition of a module of 0.1 to 0.5 may be named through the list. Facts: `name`, `module` |
| MDT-E1603 | 0.6 module imported by an earlier program | E1603, E1603a | a program or module of 0.1 to 0.5 imports a module written in 0.6 that the check is given; reported at the `use`, and not E1602 besides. Facts: `module`, `module_language`, `language` |
| MDT-E1604 | Import not closed | E1604, E1604a, E1604c, E1602c; E1604b (allowed) | 0.6 only; a `use` names a module that is not `std` itself, `std.decision`, or a module the check was given, or a module but the standard library's without a list of names (an import that lists no names brings none); reported at the `use`. The built-in `std.patterns` and the modules of a library the lock pins are not read yet, so a `use` of either that no given module satisfies is E1604 too. Facts: `module` |

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
| MDT-E1405 | Tool called where it cannot be | E1405, E1405a, E1405b | 0.6 only; a read-only tool through `effect`, a write tool as an expression, any tool in a `fn`, a contract, a skill's body, a constant or a handler; at the call. Facts: `connector`, `tool`, `problem` (`read_through_effect`, `write_as_expression`, or the kind of body: `fn`, `contract`, `skill`, `const`, `handler`) |
| MDT-E1406 | Agent holds a write tool | T02, E1406, E1406a, E1406b | 0.6 only; a `tool.call` that names a write tool in an agent's `caps` (at the capability), in a delegation's `with caps` (at it), or in a map's `with caps` when the map's body delegates, directly or through a function however deep (at the map's capability); the run-time `grant` door grants no write part of a `tool.call` either. Facts: `agent`, `capability`, `through` (`caps`, `with caps`, `map with caps`) |
| MDT-E1407 | Connector not bound in the lock | E1407, E1407a | 0.6 only; needs the lock; a connector a `tool.call` capability of the program's workflows (their caps or their envelope's) or agents names has no `connectors.<module>.<connector>` entry (path `/connectors`), or its entry has no digest for one of the tools it declares (path `/connectors/<id>/tools`). Facts: `connector`, `problem` (`no_entry`, `no_digest` with `tool`). The path is into the lock |
| MDT-E1408 | Lock binds no connector of the package | E1408, E1408a | 0.6 only; needs the lock; an entry names a connector that neither the program's module nor a module the check is given defines (path `/connectors/<id>`), or a tool the connector does not declare (`/connectors/<id>/tools/<tool>`). Facts: `connector`, `problem` (`no_connector`, `no_tool` with `tool`). The path is into the lock |

Language 0.6 extends these codes for connectors. E0121: a definition named like a
built-in effect (`Tool`, `Model`, `Fs.Read` …, and `Tool.Write`), which would
decide what covers that effect (E0121, E0121a; E0121b: a program of 0.5 is read
as before); in 0.6 a `Tool` or `Tool.Write` use is covered by a `tool.call` part
alone. E0120: a tool a connector
does not declare, in a call (`/…/callee/name`) or as an effect's name, a
connector used as a value, and a tool named without a call. E0220: an
argument of a tool's call of a class above its connector's `class` (at the
argument, T06), and a delegation whose agent holds tools of a connector and
receives data of a class above that connector's (at the delegation, T06a);
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
