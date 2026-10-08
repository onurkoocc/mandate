# Mandate

Mandate is an agent-native coordination and contract language. Agents write
and edit programs; people review them through generated views; the compiler
checks capabilities, effects, budgets, contracts and delegation before
anything runs. This repository holds the 0.1 reference implementation.

## Status

0.1 is being built in four steps:

1. **Compiler core (this step):** canonical IR with a closed JSON Schema,
   strict JSON reading, JCS + SHA-256 hashing, the `.mdt` text projection
   (parser and printer), name resolution, JSON diagnostics with repair
   patches, IR patches with `stale_base`, and the `mandate` CLI.
2. **Static checks (Gate 1):** epistemic types, effects, capabilities and
   disjoint writes, budgets, delegation and contracts.
3. **Runtime (Gate 2):** TypeScript + Temporal + PostgreSQL; event journal,
   prepare → authorize → commit, budget reservations, supervision.
4. **End to end:** the FixBug workflow running against simulated adapters,
   sandbox policy generation, and a compact core spec.

## Layout

```text
spec/        IR schema, IR rules, diagnostic codes
compiler/    reference compiler (TypeScript)
examples/    example programs; fixbug/ is the design document's §20 workflow
```

## Using the compiler

```sh
npm install
npm run build
node compiler/dist/cli.js check examples/fixbug/fixbug.mdt
node compiler/dist/cli.js check examples/fixbug/fixbug.ir.json --json
node compiler/dist/cli.js fmt examples/fixbug/fixbug.ir.json
node compiler/dist/cli.js explain E0120
npm test
```

| Command | Does |
|---|---|
| `check <file> [--json]` | Validate and resolve a `.mdt` or `.json` program; print its hash or diagnostics |
| `ir <file> [--canonical]` | Print the canonical IR (pretty, or exact JCS bytes) |
| `fmt <file>` | Print the `.mdt` projection of a program |
| `hash <file>` | Print the program hash and one hash per definition |
| `patch <program> <patch.json> [--json]` | Apply `{ "base": "sha256:…", "ops": [ … ] }` |
| `explain <code>` | Explain a diagnostic code |

Exit status is 1 when an error diagnostic is reported and 2 on usage errors.

## Conformance

Tests live in `compiler/test`. The conformance cases from the design
document's §25 that this step covers are S01 (duplicate keys), S02 (unknown
fields and versions), S03 (missing references), S10 (key order and hashing),
S11 (no silent Unicode or number normalization) and S12 (stale patch base).
