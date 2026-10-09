# mandate-fixbug-target

A small TypeScript project with a seeded bug. It is the target of the Gate 3
acceptance run of [Mandate](https://github.com/onurkoocc/mandate): the
FixBug workflow's agents find the bug, fix it, add a regression test and
open a pull request, and a person approves it.

- `src/`: the code. `pagination.ts` has the bug of issue #1.
- `test/`: the unit tests. They pass with the bug.
- `acceptance/`: the acceptance tests for issue #1. They fail until the bug
  is fixed. They are the maintainers', not the agents': a fix must not
  change them.

Node 24 runs the TypeScript directly; there are no dependencies.

```sh
npm test            # unit tests
npm run acceptance  # acceptance tests
```

Each run starts from the commit tagged `seed`.
