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
| MDT-E0105 | Resource limit exceeded | — | assigned; limits from §3.4 |
| MDT-E0106 | Number not representable | S11 | assigned |
| MDT-E0107 | Invalid Unicode | S11 | assigned |
| MDT-E0108 | Malformed JSON | — | assigned |
| MDT-E0120 | Unresolved name | S03 | assigned; carries a repair when one close name exists |
| MDT-E0121 | Duplicate name | — | assigned |
| MDT-E0130 | Stale base | S12 | assigned |
| MDT-E0131 | Patch cannot be applied | — | assigned |

`mandate explain <code>` prints the explanation for each code.

The type, effect, capability, budget, contract and delegation families
(E02xx–E07xx) arrive with the static checks.
