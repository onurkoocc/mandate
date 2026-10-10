# The lock file

A program names what it needs in general terms: a model *tier*, an imported
*module*. The lock file, `mandate.lock.json` next to the program, pins what
those names mean for one deployment. It is closed by
[`lock.schema.json`](lock.schema.json) and read as strictly as the IR:

- an unknown field is an error;
- a fractional number is an error;
- a locked model without a tariff is an error.

All of these are reported as `MDT-E0140`.

```json
{
  "lock": "mandate/lock/0.3",
  "modules": { "company.domain": "sha256:0f1e" },
  "models": {
    "standard": { "provider": "anthropic", "model": "claude-opus-5-5", "effort": "high",
                  "max_input_tokens": 128000, "max_output_tokens": 12000 }
  },
  "tariffs": {
    "claude-opus-5-5": { "currency": "USD", "as_of": "2026-10-09",
      "micros_per_mtok": { "input": 4000000, "output": 20000000, "cache_read": 200000, "cache_write": 5000000 } }
  }
}
```

| Field | Pins |
|---|---|
| `modules` | The version of every imported module other than `std` (S09) |
| `models` | For each tier: the model id and the effort sent with every call, and the input and output token limits of one call |
| `tariffs` | Each locked model's prices per million tokens, in integer micro-units of one currency, with the day they were read |
| `bindings` | What the program's agents were deployed as on an executor (`managed-agents`), written by `mandate deploy`; see [`executors.md`](executors.md). Needs format `0.3` |

The format is `mandate/lock/0.3`. A `0.2` lock, which has no bindings, is
still read.

## What reads it

- **The package.** The lock is part of the package hash:
  `SHA256("mandate/package/0.1\n" ‖ JCS({program: <program hash>, lock}))`. A changed
  price or model is a new package. A running run keeps the package it
  started with (INV-02).
- **The compiler.** `mandate check` reads `--lock <file>`, or else
  `mandate.lock.json` next to the program. With a lock it adds two checks:
  - `MDT-E0141`: every model tier the program names is locked.
  - `MDT-W0504`: every agent loop's declared budget covers its upper bound.
  - `MDT-E0903`–`MDT-E0905`: an executor binding still fits the program
    and the lock ([`executors.md`](executors.md)).
- **The runtime.** It refuses to load a package whose lock pins models but is
  malformed (`malformed_lock`) or leaves a named tier unlocked
  (`unlocked_model_tier`). Its model adapter sends each tier's model and
  effort, and prices every call from the tariff. A lock without `models` is
  for simulated models: the Anthropic adapter refuses to run without one.

## The upper bound of a call

A call's upper bound uses the locked limits, priced as if nothing hits the
cache:

```text
tokens = max_input_tokens + max_output_tokens
spend  = ⌈ (max_input_tokens × max(input, cache_write) + max_output_tokens × output) / 10⁶ ⌉
```

`cache_write` is the higher input price: a prompt that is written to the
cache costs more than one that is not. An agent loop of `steps` calls is
bounded by `steps ×` that. `MDT-W0504` warns when an agent's declared
`tokens` or `spend` is below it, because the skill may then run out of
budget before it can finish (design doc 4 §8.6).

At run time a call reserves less than this static bound:

- its input token count, measured before the call (not the input limit);
- plus the output limit.

Both are priced the same way. It is settled at its real cost:

| Dimension | Settled at |
|---|---|
| `tokens` | Input + cache reads + cache writes + output: every token the model processed |
| `spend` | Each kind of token at its own price, cache discount included |

A call whose counted input exceeds `max_input_tokens` is not sent; the
skill fails with `SkillFailed(context_exhausted)`.
