# The live acceptance session (0.7 Attention)

This is the kit with which you hold the acceptance session of release 0.7 yourself, with your own hands, in one
sitting of about an hour. You play the story the specification calls the acceptance:

> A workflow is built. The accountant approves its card. It runs in design, then read_only, then live. The accountant
> is shown only what a person in that role may see, and decides the few invoices the workflow could not decide alone.
> A deadline that passes unanswered goes to the next person. Replaying a run gives the same result.

Everything it touches is fake. The ERP and the mailbox are two small servers that run on your machine and nowhere else;
the invoices are made up; no network address outside your machine is reached. By default no model is used either: the
Matcher is simulated (it answers what a model that read the ERP would), so no key and no account are needed. The last
steps are a checklist, one line for each row of the acceptance, with what to look at and a place for your verdict. At
the end, "What this session does not show" says what a pass here does NOT prove. Read it before you sign anything off.

You need not be a developer. You copy the commands below, one at a time, and read what they print. Each step says what
you should see. Whatever does not match is a finding: write it down.

## What you need

- Node.js 22 or later (`node --version`), and this repository on your machine.
- The repository built once: from its root, `npm ci` then `npm run build`, and then `npm run build:wasm` (the compiler's
  module, `bridge/wasm`; it needs the Rust toolchain the repository pins, and is never committed). If your machine
  cannot build it, copy the `bridge/wasm` directory from a checkout that has it.
- Two terminals open in the repository's root, called A and B below. PowerShell and POSIX shells (bash, zsh) are both
  covered: where a command differs, the guide gives both.

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

It prints the session directory (a new directory under the temporary directory of your system, holding the keys, the
store and the notifications of this session; the kit refuses any directory inside a git work tree or one that is not
empty and not its own), what it serves, and three lines for each shell. Leave this terminal as it is: the world lives in
it and shows each request it receives. Ctrl+C stops it.

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
the `mandate` command of this repository (and nothing else) the session's clock, which step 12 moves, and the simulated
Matcher.

Three rules for terminal B:

- Run nothing else in it. The preload leaves every other program alone, but this terminal is the session's.
- Never start an authoring agent, or the MCP client that runs it, from terminal B (step 5): use a third terminal. The
  preload also leaves `mandate mcp` alone, but an agent must not share a terminal that has a shifted clock.
- The world's control port (it serves `status`, `drafts` and `down`) answers any program on this machine that sends its
  header, which the kit's commands do. A web page cannot (browsers are blocked), but a local program that knows the
  header can stop the world or read the fake data. It holds nothing real.

Check that terminal B sees the world:

```sh
node scripts/live-session.mjs status --session $S
```

It says the world is running, the model is simulated, and the ERP has eight orders and no post.

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

## Step 5. Who wrote the program (the authoring row)

The first row of the acceptance is that an author builds the workflow with an agent that cannot approve it. **In the
scripted variant of this guide that row is NOT shown by this session.** The program is the fixture
`fixtures/attention/invoices.mdt`, written beforehand; nothing here wrote it, and nothing here checked that an agent
could. Only the real-agent variant shows the row:

1. In a third terminal (not B), start the agent's MCP client with the server `node bridge/dist/cli.js mcp` as its MCP
   server (the agent's own configuration says how; the command is the whole of it).
2. Ask the agent to build a workflow in a file of its own, in a directory of its own, and to use the tools to check it
   (`mandate.check`) until it passes. It can explain a finding, project a view and propose a patch. It cannot sign,
   approve or promote: those are the persons' (steps 6 to 9).
3. Then carry on with steps 6 and following on the agent's program in place of the fixture (replace the program's path
   in the commands), with a lock made for it.

Mark the authoring row in the checklist as "not shown" unless you did this.

## Step 6. The accountant approves the card

Before ana approves, nothing runs:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id u0 --lock $S/invoices.lock.json --mode design --config $C
```

It stops with `unapproved_envelope`. Ben cannot approve it either (try the next command with `ben.key` and read
`not_in_role`). Ana can:

```sh
node bridge/dist/cli.js approve-envelope fixtures/attention/invoices.mdt --key $S/people/ana/ana.key --lock $S/invoices.lock.json --config $C
```

(PowerShell shows a refusal as red text. That is the runtime's own message, not a crash.)

## Step 7. The design run

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

The run is now succeeded. Look at the ERP: there are no posts, and there must be none.

```sh
node scripts/live-session.mjs drafts --session $S
```

## Step 8. Promote to read_only, and run there

Ben may not promote, because a promotion is the owner's:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key $S/people/ben/ben.key --yes --config $C
```

(`not_in_role`.) Ana promotes, and the run in read_only mode reads the fakes and still writes nothing:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key $S/people/ana/ana.key --yes --config $C
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r1 --lock $S/invoices.lock.json --mode read_only --config $C
```

Decide it as in step 7 (`1`, `waive 2 decline 5`, `y`), then check that nothing was written:

```sh
node scripts/live-session.mjs drafts --session $S
```

## Step 9. The shadow diff, and promote to live

What would the live run do that the design run did not?

```sh
node bridge/dist/cli.js shadow-diff d1 r1 --config $C
```

Six posts to the ERP that the design run did not make: five that matched and one that ana waived. Ana promotes to live,
signing that diff:

```sh
node bridge/dist/cli.js promote r1 --to live --key $S/people/ana/ana.key --yes --config $C
```

## Step 10. The live run

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id l1 --lock $S/invoices.lock.json --mode live --config $C
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js waits --member ana --config $C
node bridge/dist/cli.js watch --member ana --out $S/pages --config $C
```

`tick` is what a deployment's driver does every few seconds: it moves overdue waits and sends the notifications. Open
`pages/l1.accountant.html` in the session directory in a browser: this is the page ana is shown. Then decide, and tick
again so that the outcome is notified:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key $S/people/ana/ana.key --config $C
```

```sh
node bridge/dist/cli.js tick --config $C
node scripts/live-session.mjs drafts --session $S
```

Six posts, of six different invoices: the five that matched and the one ana waived. The two declined are not there, and
neither is the invoice of another vendor.

What ana may see of the run: `node bridge/dist/cli.js watch l1 --role accountant --jsonl --config $C` lists its
events, and each carries a `class`. What she is told: the notifications file `$S/notifications.jsonl`, one JSON line
for each, each with a `class` too.

**A second live run posts the same invoices again.** Do not run another live run of this program in this session unless
you want to see that. The operation key the runtime sends the ERP as the idempotency key is made from the tenant, the
run, the workflow's node, the effect and the value of `idempotent_by` (the invoice number): it belongs to the run. The
same invoice in another run is another key, and a server that honours the key (the fake ERP does) applies it as another
post. The idempotency the specification promises is for a run and its retries and resumes: the same key sent again is
one post (`sent` above 1 in `drafts`). It does not promise that an invoice is posted once across runs; the card's "idempotent
by invoice_no" is to be read that way. An ERP that must refuse a second draft of an invoice has to do so itself. If you
want to see it, run `l2` as `l1` (this step with `--run-id l2`, and the same decision) and look at `drafts`: twelve posts of six
invoices, each of them twice, and the tool says so. This is a question for the product's owner, not a defect of the kit.

## Step 11. The `asks` bound

The workflow may ask at most two questions in all. Three places show it: the card ("At most 2 questions", step 4), the
count in the run:

```sh
node bridge/dist/cli.js status l1 --config $C
```

(the `budget asks:` line: the limit is 2, and the settled count is within it), and a start that would be allowed more
than the limit is refused:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id x1 --lock $S/invoices.lock.json --mode design --limit asks=1 --config $C
```

It stops with `attention_above_asks`: it can ask two questions and was given room for one.

## Step 12. The deadline

A deadline passes without anyone answering. This step uses a run in read_only, so that nothing is posted twice (see the
box in step 10), and lets the days pass without waiting for them:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r2 --lock $S/invoices.lock.json --mode read_only --config $C
node bridge/dist/cli.js tick --config $C
node scripts/live-session.mjs advance 25h --session $S
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js waits --member ben --config $C
```

The first `tick` sends ana the question (look at `notifications.jsonl`: a `review_requested` for `r2` to the accountant).
Then the accountant's day passed, so the question went to ben (`waits --member ben` lists it). Let his day pass too:

```sh
node scripts/live-session.mjs advance 25h --session $S
node bridge/dist/cli.js tick --config $C
node bridge/dist/cli.js status r2 --config $C
```

The run is succeeded, with every open item declined by nobody (`"by":null`). `advance` moves the session's clock, for
every `mandate` command of terminal B, by the duration (`90m`, `25h`, `2d`); it never goes back. The program's own
deadline (one day) is unchanged.

## Step 13. Replay

Replaying a run recomputes it from its journal. The design and the live run give the same result as the run did:

```sh
node bridge/dist/cli.js status d1 --config $C
node bridge/dist/cli.js replay d1 --config $C
node bridge/dist/cli.js status l1 --config $C
node bridge/dist/cli.js replay l1 --config $C
```

Each `replay` says `replay: complete` and prints the result; the JSON is the `result:` that `status` printed. The
read_only run is a known limit:

```sh
node bridge/dist/cli.js replay r1 --config $C
```

It says `replay: partial` at the commit step: a read_only run recorded no effect to replay it against. That is how it
is, not a failure of this session.

## Step 14. The result checklist

Go through it with the session still up. Write pass, fail or not shown, and a note, for each row.

| # | Row of the acceptance | What to look at | Verdict | Notes |
|---|---|---|---|---|
| 1 | An author builds the workflow | Step 5. Scripted variant: **not shown** (the program is the fixture). Real-agent variant: the agent built it with `mandate.check` and could not approve. | | |
| 2 | The card is approved by the owner | Step 6: `unapproved_envelope` before; ben's approval `not_in_role`; ana's approval signed. | | |
| 3 | design, then read_only, then live | Steps 7 to 10: no post after design and read_only; a promotion by ana for each; the shadow diff of step 9; six posts after live. | | |
| 4 | The role sees only what it may be shown | `watch l1 --role accountant --jsonl`: the `class` of every event is S0, S1 or S2, and none above. The waits show the items, not the declined invoice of another vendor. | | |
| 5 | Notifications carry only S0 and S1 | `$S/notifications.jsonl`: the `class` of every line is `S0` or `S1`. PowerShell: `Get-Content $S/notifications.jsonl \| ForEach-Object { ($_ \| ConvertFrom-Json).class } \| Sort-Object -Unique`. POSIX: `grep -o '"class":"S[0-9]"' $S/notifications.jsonl \| sort \| uniq -c`. | | |
| 6 | The `asks` bound holds | Step 11: the card's "At most 2 questions"; the `budget asks:` line of `status l1`; the refused start with `--limit asks=1`. | | |
| 7 | A missed deadline escalates | Step 12: after the first `advance` the question is ben's; after the second the run ends with every open item declined by nobody. | | |
| 8 | Replay is equal | Step 13: `replay d1` and `replay l1` complete with the result `status` printed; `replay r1` is `partial` (a known limit). | | |

## Step 15. Stop and clean up

First end the session's clock in terminal B (PowerShell: `Remove-Item Env:NODE_OPTIONS`; POSIX shell: `unset NODE_OPTIONS`),
then:

```sh
node scripts/live-session.mjs status --session $S
node scripts/live-session.mjs down --session $S
node scripts/live-session.mjs clean --session $S
```

`down` stops the world (Ctrl+C in terminal A does too) and keeps the directory; `clean` removes what the kit made in it,
with the keys and the store, and the directory if nothing else is in it (otherwise it lists what it left). It refuses a
directory that is not the kit's session, or that is inside a git work tree.

## What this session does not show

About the product, which a pass here does not cover:

- A promotion binds no store: it holds for every later run of the same package hash and workflow, whichever store.
- Reading is not authenticated: a caller names its own role (`--role`, `--member`); only a signature is evidence.
- Replaying a read_only run returns `partial`.
- A new notification channel is told no history, only the waits open at that time.
- Identifiers that a lead model chose in a sub-program are not masked.
- The class of an effect that only the configuration hands to a person is not compared with the person's cap.
- An invoice posted in a second run is posted again (step 10): the idempotency covers a run, not the ERP's whole history.

About what the kit fakes, which a pass here does not cover either:

- The ERP and the mailbox are fakes on loopback, with the tools the library declares and nothing else.
- With the simulated Matcher, the runtime in terminal B is patched as it loads: one adapter is replaced (the line that
  would refuse an agent without a model and a sandbox). The journal records the simulated answers as a model's output and
  nothing marks them as simulated. So the session shows how the runtime handles an agent's output, not that an agent
  ran. Only `--real-model` (below) shows that, and it is not what the scripted variant runs.
- The simulated Matcher is always right about the invoice it is given: it shows the workflow's handling of what it
  returns, not the quality of a model.
- `Date` runs ahead in every `mandate` command of terminal B after `advance`, so the session store's history (journal
  times, deadlines, signed decisions, notification times) carries shifted times. A real deadline is not waited for.
- A deployment's driver: `tick` is typed here.
- Anything after the ERP: the posts stay posts.

## The commands of the kit

| Command | What it does |
|---|---|
| `node scripts/live-session.mjs up [--dir DIR] [--database URL] [--real-model]` | starts the world and prints the lines for terminal B |
| `node scripts/live-session.mjs lock --session DIR --accountant NAME=KEYFILE --finance-lead NAME=KEYFILE` | the lock from the template and the two keys |
| `node scripts/live-session.mjs status --session DIR` | what runs, the clock, the notifications |
| `node scripts/live-session.mjs inbox --session DIR` | the invoices in the fake mailbox |
| `node scripts/live-session.mjs orders --session DIR` | the open orders in the fake ERP |
| `node scripts/live-session.mjs drafts --session DIR` | every post the fake ERP was sent, and the invoices posted more than once |
| `node scripts/live-session.mjs advance DURATION --session DIR` | moves the session's clock forward |
| `node scripts/live-session.mjs down --session DIR` | stops the world |
| `node scripts/live-session.mjs clean --session DIR` | removes what the kit made in the session directory |

## A real model for the Matcher (optional)

Not needed for the acceptance above. The key comes from the environment of terminal A only, never from a file and never
from a `.env` (the kit reads none), and is not shown as you type it:

```powershell
$k = Read-Host "key" -AsSecureString
$env:CLAUDE_API_KEY = [System.Net.NetworkCredential]::new('', $k).Password
node scripts/live-session.mjs up --real-model
```

```sh
read -s CLAUDE_API_KEY && export CLAUDE_API_KEY
node scripts/live-session.mjs up --real-model
```

The runtime's own configuration is used: the model's host is the one thing besides the two fakes the egress proxy lets
through, with the key held by the proxy. Terminal B must not have the key. The agent loop also needs the sandbox the
runtime's operating system has (Windows and Linux only). Without the key, `up --real-model` stops and says so. This
path has not been run by the kit's authors: it is checked by its configuration and by reading.

## When something goes wrong

- `the session's world is not running`: terminal A has stopped or crashed; run `up` again (with `--dir` set to the same
  directory to keep what you did).
- `…/runtime/dist/… is not there`: build first (`npm run build`).
- A compiler failure at once: `bridge/wasm` is missing (`npm run build:wasm`).
- `unpromoted` or `unapproved_envelope`: the step before it was skipped, or the package changed (a new lock is a new
  package and needs a new approval).
- `not_in_role`: the wrong person's key. This is the specification working, not a failure.
- `live-session preload: not applied`: the session was cleaned while terminal B still had `NODE_OPTIONS`; unset it.
- A path with a space in it: use a session directory without one (`up --dir`).

## Turkish

This guide is in English. A Turkish version is the same fifteen steps with the prose translated; the commands, the
output they quote and the words of the product (`approve-envelope`, `read_only`, `live`) stay as they are, because they
are what you type and what you read on the screen. It would take about half a day, and a decision on whether the card
and the pages the runtime prints are translated too, which is a product decision and not this kit's.
