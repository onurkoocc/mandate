# The self-review session: Mandate reviews its own repository

This is the kit with which you run a realistic Mandate program on Mandate itself, in one sitting of about half an
hour with the simulated Reviewer, or about an hour with a real model. The story:

> A program of language `mandate/0.7` applies `BatchWithExceptions` to four components of this repository. A Reviewer
> agent reads each component in a read-only snapshot and returns one typed finding. A contract decides which findings
> are grounded. The maintainer approves the program's card, decides once on the findings the contract could not
> accept alone, and the accepted ones are appended to a local report. Replaying a run gives the same result.

Nothing leaves your machine except, with `--real-model` only, the Reviewer's requests to the model's API. The report
connector is a small server on your machine's loopback address; the report is a file in the session directory; no
GitHub issue, pull request or comment is made. By default no model is used: the Reviewer is simulated (it reads no code
and returns made-up findings with real file lines), so no key and no account are needed. The last steps are a checklist
with a place for your verdict, and "What this session does not show" says what a pass here does NOT prove.

You copy the commands below, one at a time, and read what they print. Each step says what you should see. Whatever
does not match is a finding: write it down.

## What you need

- Node.js 22 or later (`node --version`), git, and this repository on your machine.
- The repository built once: from its root, `npm ci` then `npm run build`, and then `npm run build:wasm` (the compiler's
  module, `bridge/wasm`; it needs the Rust toolchain the repository pins, and is never committed). If your machine
  cannot build it, copy the `bridge/wasm` directory from a checkout that has it.
- Two terminals open in the repository's root, called A and B below. PowerShell and POSIX shells (bash, zsh) are both
  covered: where a command differs, the guide gives both.

## What is on the table

| Who | Role | Does what |
|---|---|---|
| you | maintainer | own the program, approve its card, promote it, decide on the findings it could not accept alone |
| you | deputy | asked only if the maintainer does not answer in a day; the same person here, see below |
| the Reviewer | agent | reviews one component and reports the finding it is most sure matters (simulated by default) |

The four components, each a few files that one review can read whole:

| Task | Files | What the Reviewer looks at |
|---|---|---|
| `egress-addresses` | `runtime/src/egress/addresses.ts`, `runtime/src/egress/config.ts` | which addresses count as public; how a credential binds to hosts |
| `agent-tools` | `runtime/src/tools.ts`, `runtime/src/sandbox-helper.ts` | how a tool call becomes a sandboxed command; path checks |
| `child-env` | `runtime/src/env.ts`, `runtime/src/paths.ts` | what a child process inherits; how paths are made |
| `live-kit-preload` | `scripts/lib/live-hook.mjs`, `scripts/lib/live-loader.mjs` | what the live kit preloads, and the line it patches |

The program is `fixtures/self-review/self-review.mdt`. A finding is accepted when it is **grounded**:

| Criterion | It says | May be waived by |
|---|---|---|
| `same_task` | the finding is for this component | nobody |
| `known_file` | it names a file of the component (as the connector lists it) | nobody |
| `known_line` | its line is inside that file | nobody |
| `evidence` | it quotes evidence (at least 20 characters) | nobody |
| `graded` | its severity is low, medium or high | nobody |
| `confident` | the Reviewer's confidence is high | maintainer, deputy |

With the simulated Reviewer, two findings are grounded, one (`agent-tools`) is grounded but of medium confidence, which
you may waive, and one (`child-env`) names a line past the end of its file, which nobody may waive: it is declined
without anyone being asked. So a live run appends three entries when you waive the one, two when you decline it.

The budget. The owner's limit is **20 USD for the whole session**; a program's budget is a run's, so the program
spends at most **6 USD in a run**. Only the Reviewer spends: 4 components, at most **1.20 USD** each on the tier
`standard`, which the lock maps to Opus 5.5 (`claude-opus-5-5`, effort medium, at most 40,000 input and 4,000 output
tokens per call). So the card's static bound is **4 × 1.20 = 4.80 USD** per run, under the 6 USD. The three runs
that spend with the real model (design, read_only and live: every mode runs the model) are held to 3 × 6 = 18 USD by
the program's limit, and to 3 × 4.80 = **14.40 USD** by the Reviewer's, both under the 20 USD.

The lock's tariff prices Opus 5.5 at 4 USD per million input tokens, 5 USD per million when the input is written to
the cache, 0.20 USD when it is read from it, and 20 USD per million output tokens. The check bounds a call at the
dearest of these for its input: 40,000 × 5 + 4,000 × 20 USD per million = 0.28 USD. It warns (`MDT-W0504`) that 12
steps at that bound would be 3.36 USD: the Reviewer's 1.20 USD is the ceiling, and a review that reaches it ends
unfinished.

## Step 1. Start the world (terminal A)

```sh
node scripts/self-review.mjs up
```

It prints the commit it reviews (the repository's HEAD; `--commit REV` names another), the snapshot, the report
connector and the report file, the session directory (a new directory under the temporary directory of your system,
holding your key, the store, the notifications and the report; the kit refuses any directory inside a git work tree
or one that is not empty and not its own), and three lines for each shell. Leave this terminal as it is: the world
lives in it and shows each request the connector receives. Ctrl+C stops it.

The snapshot holds the components' files as the commit has them (`git show`), and nothing else: an untracked or
ignored file of your working tree, such as an `.env`, cannot be in it. With the simulated Reviewer the snapshot is in
the session directory; with `--real-model` it is at the one path the program grants the Reviewer (see the last
section).

## Step 2. Set up terminal B

In the second terminal, in the repository's root, paste the three lines `up` printed for your shell. For PowerShell
they look like this (the directory differs):

```powershell
$S = 'C:/Users/you/AppData/Local/Temp/mandate-self-review-1234abcd'
$C = "$S/mandate.runtime.json"
$env:NODE_OPTIONS = '--import=file:///…/scripts/lib/self-review-hook.mjs?session=…'
```

Use the lines as printed, not these. `NODE_OPTIONS` gives the `mandate` command of this repository (and nothing else)
the simulated Reviewer. Then:

```sh
node scripts/self-review.mjs status --session $S
node scripts/self-review.mjs components --session $S
```

The first says the world is running and the model is simulated; the second lists the four components with each file
and its number of lines.

## Step 3. Make the maintainer, the lock and the connector's digests

```sh
node bridge/dist/cli.js key new --out $S/people/me/me.key
node scripts/self-review.mjs lock --session $S --maintainer me=$S/people/me/me.key
node bridge/dist/cli.js connector pin fixtures/self-review/self-review.mdt --lock $S/self-review.lock.json --config $C
node bridge/dist/cli.js check fixtures/self-review/self-review.mdt --lock $S/self-review.lock.json --config $C
```

The key signs your decisions and never leaves your machine; the kit never prints it. `lock` writes
`$S/self-review.lock.json` from the template `self-review.lock.template.json`: you in both roles, your key id, the
pinned libraries and the model. `connector pin` goes through the egress proxy to the report connector: you should see
three tools and a digest for each. `check` ends with `ok sha256:…`, after warnings (`MDT-W0601`: the criteria are
checked at run time; `MDT-W0504`, see the budget above).

Why two roles for one person: `BatchWithExceptions` escalates to a role other than the one it asks first (the check
refuses the same role, `MDT-E1507`), and both must be able to waive (`MDT-E1508`). With one maintainer, the deputy is
the same person.

## Step 4. Read the card

```sh
node bridge/dist/cli.js view fixtures/self-review/self-review.mdt --card --workflow ReviewRepository --lock $S/self-review.lock.json --config $C
```

You should see:

- "Spend bound of map it: 4 × 1.20 USD = 4.80 USD ≤ 6 USD", and in "The most it spends" the row
  `spend (USD) | 6 USD | 4.8 USD | 1.2 USD`;
- under "What it can touch", the read path `/mandate-self-review/snapshot` and nothing to write, no network host and no
  command: the Reviewer reads, and only the workflow appends to the report;
- "At most 2 questions in all (asks: 2)", the maintainer and then the deputy, a day each;
- the contract's table, with `confident` the only criterion that may be waived.

## Step 5. Approve the card

```sh
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id u0 --lock $S/self-review.lock.json --mode design --config $C
node bridge/dist/cli.js approve-envelope fixtures/self-review/self-review.mdt --key $S/people/me/me.key --lock $S/self-review.lock.json --config $C
```

The first is refused with `unapproved_envelope`: nothing runs before the card is approved. The second signs it.

## Step 6. The design run

```sh
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id d1 --lock $S/self-review.lock.json --mode design --config $C
node bridge/dist/cli.js waits --member me --config $C
node bridge/dist/cli.js decide --key $S/people/me/me.key --config $C
```

The run ends `waiting`: one item (`agent-tools`) failed only `confident`. `waits` shows that item, with the finding as
the model's output; `child-env` is declined without asking ("declined without asking …: 2", its index). `decide` asks
which decision (type `1`), then `waive 1`, then `y`. The run is `succeeded`. `report --session $S` holds no entry: a
design run writes nothing.

## Step 7. Promote to read_only, run there, and the shadow diff

```sh
node bridge/dist/cli.js promote d1 --to read_only --key $S/people/me/me.key --yes --config $C
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id r1 --lock $S/self-review.lock.json --mode read_only --config $C
node bridge/dist/cli.js decide --key $S/people/me/me.key --config $C
node bridge/dist/cli.js shadow-diff d1 r1 --config $C
node bridge/dist/cli.js promote r1 --to live --key $S/people/me/me.key --yes --config $C
```

Decide as in step 6. The report still holds no entry. The shadow diff lists three `report.append_finding` lines,
`only_b`: read_only prepared the three appends and applied none. The promotion to live says
`report.append_finding: 3 would apply`.

## Step 8. The live run

```sh
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id l1 --lock $S/self-review.lock.json --mode live --config $C
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js watch --member me --out $S/pages --config $C
node bridge/dist/cli.js decide --key $S/people/me/me.key --config $C
node scripts/self-review.mjs report --session $S
```

`tick` sends the notifications (to `$S/notifications.jsonl`). `watch` writes the maintainer's pages (open
`$S/pages/l1.maintainer.html` in a browser). After the decision the run is `succeeded`, and `report` shows three
entries, R-1 to R-3: `egress-addresses`, `agent-tools` (confidence medium: the one you waived) and
`live-kit-preload`. Open `$S/report.md`: each entry has the component, the file and line, severity and confidence,
what is wrong, and the evidence. `child-env` is not in it.

## Step 9. The `asks` bound

```sh
node bridge/dist/cli.js status l1 --config $C
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id x1 --lock $S/self-review.lock.json --mode design --limit asks=1 --config $C
```

`status` has a line `budget asks: limit 2, …`. The second is refused with `attention_above_asks`: the program can ask
two questions (the maintainer's and the deputy's), above a limit of one.

## Step 10. Replay

```sh
node bridge/dist/cli.js replay d1 --config $C
node bridge/dist/cli.js replay l1 --config $C
node bridge/dist/cli.js replay r1 --config $C
```

The first two say `replay: complete` and print the result `status d1` and `status l1` print. `replay r1` says
`replay: partial`, a known limit of read_only runs. A replay calls no model.

## Step 11. A second live run

```sh
node bridge/dist/cli.js run fixtures/self-review/self-review.mdt --workflow ReviewRepository --input '{}' --run-id l2 --lock $S/self-review.lock.json --mode live --config $C
node bridge/dist/cli.js decide --key $S/people/me/me.key --config $C
node scripts/self-review.mjs report --session $S
```

The run sends the same three findings again, under new operation keys (an operation key belongs to a run). The report
connector is idempotent by the finding too (its component, file and line), so it appends nothing the second time:
`report` still shows three entries, and says the three were sent again and appended nothing. Terminal A shows "the
same finding is already in the report". With a real model the findings of a second run may differ, and a different
finding is a new entry. Skip this step with a real model: it spends.

## Step 12. The result checklist

The figures in steps 6 to 11 and in rows 4 to 6 and 8 below (one item waiting, `child-env` declined, three report
entries, "3 would apply") are the simulated Reviewer's. With a real model the number of items waiting, which are
declined and the report's entries differ from run to run, and that is not a finding by itself. What has to hold in
both modes: no report entry before the live run; in the report, only findings the contract accepted or you waived,
each once; the `asks` bound (row 7); what the maintainer is shown (row 10); and replay (row 8: the design and live runs
replay to their own results, whatever they were).

| # | What | What to look at | Verdict | Notes |
|---|---|---|---|---|
| 1 | The program checks | Step 3: `check` ends `ok sha256:…`. | | |
| 2 | The card shows the limit and the bound | Step 4: 6 USD a run, 4 × 1.20 = 4.80 USD, the one read path, no write path or host. | | |
| 3 | Nothing runs unapproved | Step 5: `unapproved_envelope`, then a signed approval. | | |
| 4 | design, then read_only, then live | Steps 6 to 8: no entry after design and read_only; the shadow diff's appends (three, simulated); the entries after live (three, simulated). | | |
| 5 | The contract decides, the person decides the rest | Step 6: the items that failed only `confident` are asked about (one, simulated); those that failed another criterion are declined unasked (one, simulated: `known_line`). | | |
| 6 | Each accepted finding is appended once | Steps 8 and 11: each entry once (three, not six, simulated). | | |
| 7 | The `asks` bound holds | Step 9. | | |
| 8 | Replay is equal | Step 10: `d1` and `l1` complete with their results; `r1` partial. | | |
| 9 | With a real model: the findings | The last section: each entry names a real line, and the evidence is on that line. | | |
| 10 | The maintainer sees only what the role may be shown | `watch l1 --role maintainer --jsonl --config $C`: the `class` of every event is S0, S1 or S2. `$S/notifications.jsonl`: every line's `class` is S0 or S1 (PowerShell: `Get-Content $S/notifications.jsonl \| ForEach-Object { ($_ \| ConvertFrom-Json).class } \| Sort-Object -Unique`; POSIX: `grep -o '"class":"S[0-9]"' $S/notifications.jsonl \| sort \| uniq -c`). | | |

## Step 13. Stop and clean up

First end the preload in terminal B (PowerShell: `Remove-Item Env:NODE_OPTIONS`; POSIX shell: `unset NODE_OPTIONS`),
then:

```sh
node scripts/self-review.mjs down --session $S
node scripts/self-review.mjs clean --session $S
```

With a real model, clear the key in terminal A once `up` has stopped:

```powershell
Remove-Item Env:CLAUDE_API_KEY; Remove-Variable k
```

```sh
unset CLAUDE_API_KEY
```

Copy `$S/report.md` somewhere first if you want to keep it: `clean` removes what the kit made in the session directory
(your key, the store, the report) and the snapshot, if it is this session's, and the directory if nothing else is in
it. It refuses a directory that is not the kit's session, or that is inside a git work tree.

## What this session does not show

About the product, which a pass here does not cover:

- Every Reviewer can read the whole snapshot, not only its own component: `BatchWithExceptions` takes the workflow's
  grants for every item and has no way to narrow `fs.read` to the item's files. The snapshot holds only the four
  components, so that is all there is to read.
- A contract cannot say "every finding of a list" (there is no quantifier over a list), so a review returns one
  finding, not several. Nor can it ask whether a file exists: `known_file` checks the file against the list the
  connector gives, which the kit made from the snapshot.
- A budget is a run's. Nothing in the program caps what several runs spend together: the owner's 20 USD total is
  kept by running at most three spending runs (see the last section), not by a limit the runtime holds. Every mode
  spends: a design run runs the model too.
- Replaying a read_only run returns `partial`.
- One person in two roles: the escalation to the deputy goes to the same person.

About what the session reviews:

- Only four components are reviewed, 8 files of the repository. A short or an empty report says nothing about the
  rest of the repository, nor that these 8 files are free of defects: each review reports at most one finding.

About what the kit fakes, which a pass here does not cover either:

- The real-model path (the last section) has not been run by the kit's author: no model call through the proxy, no
  Reviewer loop in the sandbox, no real finding and no real spend has been seen. A pass with the simulated Reviewer
  says nothing about it.

- With the simulated Reviewer, the runtime in terminal B is patched as it loads: one adapter is replaced (the line that
  would refuse an agent without a model and a sandbox). No code is read, no sandbox is opened and nothing marks the
  findings as simulated in the journal, only their titles in the report. So the session shows how the runtime handles
  a Reviewer's findings, not that a Reviewer ran or that its findings are right.
- The report connector is the kit's own small server on loopback, with the three tools the library declares.
- `tick` is typed here; no deadline is waited for.

## The commands of the kit

| Command | What it does |
|---|---|
| `node scripts/self-review.mjs up [--dir DIR] [--database URL] [--commit REV] [--real-model]` | starts the world and prints the lines for terminal B |
| `node scripts/self-review.mjs lock --session DIR --maintainer NAME=KEYFILE` | the lock from the template and the maintainer's key |
| `node scripts/self-review.mjs status --session DIR` | what runs, the commit, the snapshot, the report's entries |
| `node scripts/self-review.mjs components --session DIR` | the components the connector lists, with their files |
| `node scripts/self-review.mjs report --session DIR` | the report's entries |
| `node scripts/self-review.mjs down --session DIR` | stops the world |
| `node scripts/self-review.mjs clean --session DIR` | removes what the kit made, with the snapshot |

## A real model for the Reviewer

**This path has not been run by the kit's author**: it needs a key, and spends. It is checked by its configuration,
by the real AppContainer sandbox reading a snapshot at a path of this shape on Windows, and by reading. Run steps 1 to
10 with it, not step 11.

The owner's limit is 20 USD for the session, and the runtime holds only each run's 6 USD. At most three spending runs
fit in the 20 USD: the design run d1, the read_only run r1 and the live run l1 (3 × 6 = 18 USD at the most; the
Reviewer's own bound makes it 14.40). `u0` and `x1` are refused before they start and spend nothing; a replay calls no
model. A rerun of a run that failed or stopped counts as one of the three. Start no fourth spending run unless
the settled spend of all runs so far, plus 6 USD, is at most 20 USD. Add up `budget spend:USD … settled` of `status <run>` for every run as you go.

The outputs of steps 6 to 11 differ with a real model (step 12 says what must hold in both modes): how many items
wait for you, which are declined and what the report holds depend on what the Reviewer found. Decide each waiting item
as you judge it: `waive` the ones you accept despite the Reviewer's lower confidence, `decline` the others.

The key comes from the environment of terminal A only, never from a file and never from a `.env` (the kit reads none),
and is not shown as you type it:

```powershell
$k = Read-Host "key" -AsSecureString
$env:CLAUDE_API_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node scripts/self-review.mjs up --real-model
```

```sh
read -s CLAUDE_API_KEY && export CLAUDE_API_KEY
node scripts/self-review.mjs up --real-model
```

What changes:

- The egress proxy in terminal A holds the key: the model's host (`api.anthropic.com`) is the one thing besides the
  report connector it lets through, and the runtime reaches the model through the proxy's gateway. Terminal B must not
  have the key (the runtime refuses to start with it there, `credential_in_environment`). `up` prints no
  `NODE_OPTIONS` for terminal B: paste the lines it prints, which also remove one left from an earlier session.
- The Reviewer is the runtime's own agent loop, in the sandbox of your operating system (Windows: an AppContainer, which
  needs Windows 11 24H2, build 26100.9278 or later; Linux: Bubblewrap). The model runs in the runtime, not in the sandbox; the sandbox has
  no network at all. The Reviewer's tools are `read_file`, `list_dir` and `grep`, inside the snapshot only.
- The snapshot is at `/mandate-self-review/snapshot`, the path the program grants: on Windows `C:\mandate-self-review\snapshot`
  when the repository is on drive C (the path has no drive letter, so it is on the drive you run from). On Linux,
  make `/mandate-self-review` once and give it to yourself (`sudo mkdir /mandate-self-review && sudo chown $USER
  /mandate-self-review`). The path names no person on purpose: the Reviewer's tools show it to the model. `clean`
  removes the snapshot.
- Each run spends up to 4.80 USD (the Reviewer's bound), and the runtime stops it at 6 USD. `status <run>` shows the
  `budget spend:USD` line: settled and reserved.

What to look at in the report: does each entry's line hold what its evidence quotes (open the file at that line in
the commit `up` printed)? Is what it says wrong really wrong? That is row 9 of the checklist, and the reason for the
session. A finding the contract accepted is grounded, not true: the contract checks that it names a real file and line
and quotes something, not that it is right.

## When something goes wrong

- `the session's world is not running`: terminal A has stopped; run `up` again with `--dir` set to the same directory.
  The report is kept (it is read back from `$S/report.jsonl`).
- `…/runtime/dist/… is not there`: build first (`npm run build`).
- A compiler failure at once: `bridge/wasm` is missing (`npm run build:wasm`).
- `unapproved_envelope` or `unpromoted`: the step before it was skipped, or the package changed.
- `self-review preload: not applied`: the session was cleaned while terminal B still had `NODE_OPTIONS`; unset it.
- With a real model, `ContextExhausted` or a review that ends unfinished: the Reviewer reached the lock's 40,000 input
  tokens or its 1.20 USD. Its item fails, and is neither asked about nor appended.
