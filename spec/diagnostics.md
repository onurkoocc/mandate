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
| MDT-E0108 | Malformed JSON | — | assigned |
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
| MDT-E0210 | Inferred value where T is expected | V01, V08 | Appendix B |
| MDT-E0211 | Untrusted value where T is expected | — | assigned |
| MDT-E0212 | Verified against a different contract | — | Appendix B |
| MDT-E0213 | Protected type produced by a program | S08 | assigned |
| MDT-E0215 | Untrusted text in an instruction position | V02 | Appendix B |
| MDT-E0220 | Data class above what the model may receive | V04 | Appendix B |
| MDT-E0230 | Non-exhaustive switch | S05, V07 | Appendix B |
| MDT-E0231 | Switch on a raw decision | — | assigned |
| MDT-W0232 | Choice without an out-of-scope option | — | assigned |
| MDT-E0233 | Too many Choice options | — | assigned |
| MDT-W0207 | peek on model output | — | assigned |
| MDT-E0301 | Capability not in scope | — | Appendix B |
| MDT-E0305 | Capability widened | — | Appendix B |
| MDT-W0310 | Unused capability | — | Appendix B |
| MDT-W0311 | Policy and real use disagree (learning mode) | — | Appendix B |
| MDT-E0320 | Overlapping writes in par | V03 | Appendix B |
| MDT-E0401 | Undeclared effect | — | Appendix B |
| MDT-E0402 | Unknown effect | — | assigned |
| MDT-E0403 | Missing idempotency | — | Appendix B |
| MDT-E0405 | Irreversible effect without human approval | — | Appendix B |
| MDT-E0408 | External write outside a workflow | S07 | Appendix B |
| MDT-E0501 | Child budgets exceed the parent | — | Appendix B |
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
module) at load; see [`runtime.md`](runtime.md). W0504 needs model tariffs
and is not reported yet.

## Target generation

| Code | Title | Conformance case | Notes |
|---|---|---|---|
| MDT-E0902 | Sandbox requirement cannot be enforced | G05 | Appendix B; raised by the sandbox adapter as `unsupported_sandbox_profile` |
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
| MDT-E1101 | Change set order breaks the interface graph | — | assigned; an additive change's provider lands first and is a member; no cycles |
| MDT-E1102 | Change set order does not list its members | — | assigned |
| MDT-E1103 | Breaking change in one change set | — | assigned; expand → migrate → contract |
| MDT-E1104 | Change set member is not a critical effect | — | assigned |
| MDT-E1105 | Change set without a verified plan | — | assigned |
| MDT-E1201 | Read not as declared | — | assigned; data.read of a declared read, its parameters by name, max_class |
