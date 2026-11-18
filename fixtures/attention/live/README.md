# The live acceptance session (0.7 Attention)

This is the kit with which you hold the acceptance session of release 0.7 yourself, with your own hands, in one
sitting of about forty minutes. You play the story the specification calls the acceptance:

> A workflow is built. The accountant approves its card. It runs in design, then read_only, then live. The accountant
> is shown only what a person in that role may see, and decides the few invoices the workflow could not decide alone.

Everything it touches is fake. The ERP and the mailbox are two small servers that run on your machine and nowhere else;
the invoices are made up; no network address outside your machine is reached. By default no model is used either: the
Matcher is simulated (it answers what a model that read the ERP would), so no key and no account are needed.

You need not be a developer. You copy the commands below, one at a time, and read what they print. Each step says what
you should see. Whatever does not match is a finding: write it down.

## What you need

- Node.js 22 or later (`node --version`), and this repository on your machine.
- The repository built once: from its root, `npm ci` then `npm run build`, and then `npm run build:wasm` (the compiler's
  module, `bridge/wasm`; it needs the Rust toolchain the repository pins, and is never committed). If your machine
  cannot build it, copy the `bridge/wasm` directory from a checkout that has it.
- Two terminals open in the repository's root. PowerShell and POSIX shells (bash, zsh) are both covered: where a command
  differs, the guide gives both.

## What is on the table

| Who | Role | Does what |
|---|---|---|
| ana | accountant | owns the workflow, approves its card, promotes it, answers the review |
| ben | finance_lead | is asked only if ana does not answer in a day |
| the Matcher | agent | matches each invoice to an open order (simulated) |

The mailbox holds eight invoices and the ERP eight open orders. Five invoices match their orders (one is 1% off, which
the contract allows). Two are 5% off in total: ana may waive that. One is matched to an order of another vendor: nobody
may waive that, and it is declined without anyone being asked. So a live run posts five drafts to the ERP, and six
when ana waives one of the two.

The program is `fixtures/attention/invoices.mdt` and is not changed. Its lock is made from a template in this
directory (`invoices.lock.template.json`) and your two keys.

## Step 1. Start the world (terminal A)

```sh
node scripts/live-session.mjs up
```

It prints the session directory (a new directory under the temporary directory of your system, outside the repository,
holding the keys, the store and the notifications of this session and nothing that is committed), what it serves, and
three lines for each shell. Leave this terminal as it is: the world lives in it and shows each request it receives.
Ctrl+C stops it.

`up` refuses to serve anything but this machine: the fakes listen on the loopback address only, and the lock's connector
hosts must be loopback or names reserved for documentation (`*.example`).

## Step 2. Set up terminal B

In the second terminal, in the repository's root, paste the three lines `up` printed for your shell. For PowerShell they
look like this (the directory and the address differ):

```powershell
$S = 'C:/Users/you/AppData/Local/Temp/mandate-live-1234abcd'
$C = "$S/mandate.runtime.json"
$env:NODE_OPTIONS = '--import=file:///…/scripts/lib/live-hook.mjs?session=…'
```

and for a POSIX shell, `export S=…`, `export C="$S/mandate.runtime.json"` and `export NODE_OPTIONS=…`. Use the lines
as printed, not these. `$S` is the session directory, `$C` the runtime's configuration inside it. `NODE_OPTIONS` gives
every command you run in this terminal the session's clock (step 11 moves it) and the simulated Matcher.

Check that terminal B sees the world:

```sh
node scripts/live-session.mjs status --session $S
```

It says the world is running, the model is simulated, and the ERP has eight orders and no draft.

## Step 3. Make the two people

Each person makes their own key. It signs their decisions and never leaves your machine; the kit never prints it.

```sh
node bridge/dist/cli.js key new --out $S/people/ana/ana.key
node bridge/dist/cli.js key new --out $S/people/ben/ben.key
```

Each prints a key id and where the key is. Then the lock, with no JSON to edit:

```sh
node scripts/live-session.mjs lock --session $S --accountant ana=$S/people/ana/ana.key --finance-lead ben=$S/people/ben/ben.key
```

It writes `$S/invoices.lock.json` from the template: ana in the accountant role, ben in the finance lead's, their key
ids, and puts their public keys where the runtime trusts them. Then the connectors' tool digests, which the lock must
pin (this is the real `connector pin`, going through the egress proxy to the two fakes):

```sh
node bridge/dist/cli.js connector pin fixtures/attention/invoices.mdt --lock $S/invoices.lock.json --config $C
```

You should see five tools and a digest for each.

## Step 4. Read the card

```sh
node bridge/dist/cli.js view fixtures/attention/invoices.mdt --card --workflow MatchInvoices --lock $S/invoices.lock.json --config $C
```

This is the page ana approves. Read "What it can touch", "The most it spends" and "When it asks whom": at most two
questions, a day for the accountant, then the finance lead, then every open item declined by nobody.

## Step 5. The accountant approves the card

Before ana approves, nothing runs:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id u0 --lock $S/invoices.lock.json --mode design --config $C
```

It stops with `unapproved_envelope`. Ben cannot approve it either (try the next command with `ben.key` and read
`not_in_role`). Ana can:

```sh
node bridge/dist/cli.js approve-envelope fixtures/attention/invoices.mdt --key $S/people/ana/ana.key --lock $S/invoices.lock.json --config $C
```

## Step 6. The design run

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id d1 --lock $S/invoices.lock.json --mode design --config $C
```

A design run reads sample data and writes nothing. It stops waiting: two items failed a criterion that a person may
waive. Look at what ana is asked:

```sh
node bridge/dist/cli.js waits --member ana --config $C
```

Item 2 and item 5, each with the invoice, the order and what is unmet. The invoice matched to another vendor's order is
not listed: it is declined without asking. Now ana decides. The easy way is the guided one, which asks you:

```sh
node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

Answer `1` to "Which one?", then `waive 2 decline 5`, then `y` to sign. To type nothing, the scripted form:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

The run is now succeeded. Open the ERP's drafts: there are none, and there must be none.

```sh
node scripts/live-session.mjs drafts --session $S
```

## Step 7. Promote to read_only, and run there

Ben may not promote, because a promotion is the owner's:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key $S/people/ben/ben.key --yes --config $C
```

(`not_in_role`.) Ana promotes, and the run in read_only mode reads the real fakes and still writes nothing:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key $S/people/ana/ana.key --yes --config $C
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r1 --lock $S/invoices.lock.json --mode read_only --config $C
```

Decide it as in step 6 (`1`, `waive 2 decline 5`, `y`), then check that nothing was written:

```sh
node scripts/live-session.mjs drafts --session $S
```

## Step 8. The shadow diff, and promote to live

What would the live run do that the design run did not?

```sh
node bridge/dist/cli.js shadow-diff d1 r1 --config $C
```

Six posts to the ERP that the design run did not make: five that matched and one that ana waived. Ana promotes to live,
signing that diff:

```sh
node bridge/dist/cli.js promote r1 --to live --key $S/people/ana/ana.key --yes --config $C
```

## Step 9. The live run

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id l1 --lock $S/invoices.lock.json --mode live --config $C
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js waits --member ana --config $C
node bridge/dist/cli.js watch --member ana --out $S/pages --config $C
```

`tick` is what a deployment's driver does every few seconds: it moves overdue waits and sends the notifications. Open
`pages/l1.accountant.html` in the session directory in a browser: this is the page ana is shown. Then decide:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

and look in the ERP:

```sh
node scripts/live-session.mjs drafts --session $S
```

Six drafts: the five that matched and the one ana waived. The two declined are not there, and neither is the invoice
of another vendor. Also look at what ana was told, in the notifications file `$S/notifications.jsonl`, and at what she
may see of the run: `node bridge/dist/cli.js watch l1 --role accountant --jsonl --config $C` lists its events, and each
carries a class from S0 to S2 and no more.

## Step 10. The deadline

Run it again so that something is left unanswered, and let the days pass without waiting for them:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id l2 --lock $S/invoices.lock.json --mode live --config $C
node scripts/live-session.mjs advance 25h --session $S
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js waits --member ben --config $C
```

The accountant's day passed, so the question went to ben (`waits --member ben` lists it). Let his day pass too:

```sh
node scripts/live-session.mjs advance 25h --session $S
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js status l2 --config $C
```

The run is succeeded, with every open item declined by nobody (`"by":null`). The drafts of the five that matched were
already in the ERP: a run does not post one twice. `advance` moves the session's clock, for every command of terminal
B, by the duration (`90m`, `25h`, `2d`); it never goes back. The program's own deadline (one day) is unchanged.

## Step 11. Stop and clean up

```sh
node scripts/live-session.mjs status --session $S
node scripts/live-session.mjs down --session $S
node scripts/live-session.mjs clean --session $S
```

`down` stops the world (Ctrl+C in terminal A does too) and keeps the directory; `clean` removes it, with the keys and
the store. In PowerShell, `Remove-Item Env:NODE_OPTIONS` and in a POSIX shell `unset NODE_OPTIONS` end the session's
clock in terminal B.

## The commands of the kit

| Command | What it does |
|---|---|
| `node scripts/live-session.mjs up [--dir DIR] [--database URL] [--real-model]` | starts the world and prints the lines for terminal B |
| `node scripts/live-session.mjs lock --session DIR --accountant NAME=KEYFILE --finance-lead NAME=KEYFILE` | the lock from the template and the two keys |
| `node scripts/live-session.mjs status --session DIR` | what runs, the clock, the notifications |
| `node scripts/live-session.mjs inbox --session DIR` | the invoices in the fake mailbox |
| `node scripts/live-session.mjs orders --session DIR` | the open orders in the fake ERP |
| `node scripts/live-session.mjs drafts --session DIR` | the draft invoices a live run wrote |
| `node scripts/live-session.mjs advance DURATION --session DIR` | moves the session's clock forward |
| `node scripts/live-session.mjs down --session DIR` | stops the world |
| `node scripts/live-session.mjs clean --session DIR` | removes the session directory |

## A real model, and a real authoring agent (optional)

Both are optional and neither is needed for the acceptance above.

**A real model for the Matcher.** The key comes from the environment of terminal A only, never from a file and never
from a `.env` (the kit reads none):

```powershell
$env:CLAUDE_API_KEY = Read-Host "key"
node scripts/live-session.mjs up --real-model
```

```sh
read -s CLAUDE_API_KEY && export CLAUDE_API_KEY
node scripts/live-session.mjs up --real-model
```

The runtime's own configuration is used: the model's host is the one thing besides the two fakes the egress proxy lets
through, with the key held by the proxy. Terminal B must not have the key. The agent loop also needs the sandbox
the runtime's operating system has (Windows and Linux only). Without the key, `up --real-model` stops and says so.

**A real authoring agent.** Any agent that speaks MCP can build the workflow with the tools of `mandate mcp`:

```sh
node bridge/dist/cli.js mcp
```

Point the agent's MCP configuration at that command. It can check a program, explain a finding, project a view and
propose a patch. It cannot sign, approve or promote: those are the persons' own, as in steps 5 to 9.

## What this does not show

- A real ERP or a real mailbox: both are fakes with the same tools the library declares, nothing more.
- The behaviour of a real model: the simulated Matcher is always right about the invoice it is given, so what is shown
  is the workflow's handling of what it returns, not its quality.
- The real time: the deadline is moved, not waited for.
- A deployment's driver: `tick` is typed here.
- Anything after the ERP: the drafts stay drafts.

## When something goes wrong

- `the session's world is not running`: terminal A has stopped or crashed; run `up` again (with `--dir` set to the same
  directory to keep what you did).
- `…/runtime/dist/… is not there`: build first (`npm run build`).
- A compiler failure at once: `bridge/wasm` is missing (`npm run build:wasm`).
- `unpromoted` or `unapproved_envelope`: the step before it was skipped, or the package changed (a new lock is a new
  package and needs a new approval).
- `not_in_role`: the wrong person's key. This is the specification working, not a failure.
- A path with a space in it: use a session directory without one (`up --dir`).

## Turkish

This guide is in English. A Turkish version is the same eleven steps with the prose translated; the commands, the
output they quote and the words of the product (`approve-envelope`, `read_only`, `live`) stay as they are, because they
are what you type and what you read on the screen. It would take about half a day, and a decision on whether the card
and the pages the runtime prints are translated too, which is a product decision and not this kit's.
