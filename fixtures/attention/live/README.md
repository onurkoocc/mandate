# The live acceptance session (0.7 Attention)

This is the kit with which you hold the acceptance session of release 0.7 yourself, with your own hands, in one
sitting of about an hour. You play the story the specification calls the acceptance:

> A workflow is built. The accountant approves its card. It runs in design, then read_only, then live. The accountant
> is shown only what a person in that role may see, and decides the few invoices the workflow could not decide alone.
> A deadline that passes unanswered goes to the next person. Replaying a run gives the same result.

Everything it touches is fake. The ERP and the mailbox are two small servers that run on your machine and nowhere else;
the invoices are made up. With the default, simulated Matcher (it answers what a model that read the ERP would) no model
is used, no key and no account are needed, and the session reaches only those local fakes; the item numbers, the answers
and the counts below apply to it. In the optional real-model variant (the end of this guide) step 2 reports `model real`
instead of `simulated`, the egress proxy may contact the model's host, `api.anthropic.com`, and a real Matcher can
return another match or fail: read the actual wait before you decide, use the item numbers it shows, and write down the
outcomes you observe instead of the ones quoted here. The last steps are a checklist, one line for each row of the
acceptance, with what to look at and a place for your verdict. At the end, "What this session does not show" says what a
pass here does NOT prove. Read it before you sign anything off.

You need not be a developer. You copy the commands below, one at a time, and read what they print. Each step says what
you should see. Whatever does not match is a finding: write it down.

Who operates and who judges. The specification gives a verdict on the acceptance to the participant, not to the
operator: a criterion is passed only on the participant's word, and the release's criterion asks for a participant who
does not write software. So write down, before step 1, who operates the kit and who participates.

- The operator runs the commands, including the ones that print the raw run: `run`, `status`, `drafts`, `replay` and
  `tick`. What they print is the operator's report (review data, results, evidence, action receipts), which is not what
  a role is shown. `$S/notifications.jsonl` is one shared file for both roles. If the participant reads those, they
  have seen more than the accountant is shown, and what they then say about "what the accountant saw" does not count.
- The participant is shown, for each role, only that role's views: its stream (`watch --role`), its waits (`waits`),
  its decision screen (`decide`), its page (`pages/…`) and the notifications addressed to that role. The participant
  gives each verdict in their own words.
- If you play both parts alone, that is allowed and it is a record of its own: write "operator and participant are the
  same person" in the notes of every row, keep to the participant's views when you judge rows 4 and 5, and leave the
  release's criterion (a participant who does not write software) outstanding. This guide cannot close it.

## What you need

- Node.js: check `node --version`. The repository enforces its engines when installing, so use 22.23.4 or later in the
  22.x line, 24.22.1 or later in the 24.x line, or 26.12.1 or later. And this repository on your machine.
- The repository built once: from its root, `npm ci` then `npm run build`, and then `npm run build:wasm` (the compiler's
  module, `bridge/wasm`; it needs the Rust toolchain the repository pins, and is never committed). If your machine
  cannot build it, copy the `bridge/wasm` directory from a checkout that has it.
- Two terminals open in the repository's root, called A and B below. PowerShell and POSIX shells (Git Bash, bash, zsh)
  are both covered: where a command differs, the guide gives both.

How to read the commands: each command is in a block of its own. Run the blocks in the order they stand, one at a
time. `up` (step 1) is the exception: it stays in the foreground in terminal A and is never waited for; leave it
running and carry on in terminal B. Every other command ends by itself: wait for it to end before the next one. Where
the guide gives alternatives it says "Either … or …", with PowerShell first:
run exactly one of them, not all. (Running a second one of two ways to decide the same wait is harmless: it prints
`nothing waits for …` and signs nothing.)

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
empty and not its own), what it serves, and three lines for each shell. Leave this terminal as it is and do not wait for
`up` to end: the world lives in it, and it stays in the foreground. It logs the tool calls the two fakes receive and the
requests they refuse for a missing or wrong credential (not every request). Ctrl+C stops it.

`up` refuses to serve anything but this machine: the fakes listen on the loopback address only, and the lock's connector
hosts must be loopback or names reserved for documentation (`*.example`).

## Step 2. Set up terminal B

In the second terminal, in the repository's root, paste the three assignments `up` printed for your shell, one at a
time, each as its own command. Paste the assignments of one shell only. The directory and the address differ from these
illustrations; use the lines as printed, not these.

Either PowerShell:

```powershell
$S = 'C:/Users/you/AppData/Local/Temp/mandate-live-1234abcd'
```

```powershell
$C = "$S/mandate.runtime.json"
```

```powershell
$env:NODE_OPTIONS = '--import=file:///…/scripts/lib/live-hook.mjs?session=…'
```

or a POSIX shell (Git Bash, bash, zsh):

```sh
export S='/tmp/mandate-live-1234abcd'
```

```sh
export C="$S/mandate.runtime.json"
```

```sh
export NODE_OPTIONS='--import=file:///…/scripts/lib/live-hook.mjs?session=…'
```

Every command below that takes `$S` or `$C` has them in double quotes, because a directory name can hold a space; keep
the quotes when you copy.

`$S` is the session directory, `$C` the runtime's configuration inside it. `NODE_OPTIONS` gives the `mandate` command
of this repository (and nothing else) the session's clock, which step 12 moves, and the simulated Matcher.

Three rules for terminal B:

- Run nothing else in it. The preload leaves every other program alone, but this terminal is the session's.
- Never start an authoring agent, or the MCP client that runs it, from terminal B (step 5): use a third terminal. The
  preload also leaves `mandate mcp` alone, but an agent must not share a terminal that has a shifted clock.
- The world's control port (it serves `status`, `drafts` and `down`) answers any program on this machine that sends its
  header, which the kit's commands do. A web page cannot (browsers are blocked), but a local program that knows the
  header can stop the world or read the fake data. It holds nothing real.

Check that terminal B sees the world:

```sh
node scripts/live-session.mjs status --session "$S"
```

It says the world is running, the model is simulated (`real` in the real-model variant at the end of this guide), and the
ERP has eight orders and no post.

## Step 3. Make the two people

Each person makes their own key. It signs their decisions and never leaves your machine; the kit never prints it.

```sh
node bridge/dist/cli.js key new --out "$S/people/ana/ana.key"
```

```sh
node bridge/dist/cli.js key new --out "$S/people/ben/ben.key"
```

Each prints a key id and where the key is. Then the lock, with no JSON to edit:

```sh
node scripts/live-session.mjs lock --session "$S" --accountant "ana=$S/people/ana/ana.key" --finance-lead "ben=$S/people/ben/ben.key"
```

It writes `$S/invoices.lock.json` from the template: ana in the accountant role, ben in the finance lead's, their key
ids, and puts their public keys where the runtime trusts them. Then the connectors' tool digests, which the lock must
pin (this is the real `connector pin`, going through the egress proxy to the two fakes):

```sh
node bridge/dist/cli.js connector pin fixtures/attention/invoices.mdt --lock "$S/invoices.lock.json" --config "$C"
```

You should see five tools and a digest for each.

The lock is also what lets the program be checked. The program imports modules of a library (`acme.connectors`) that
the lock pins and `$C` points to, so a plain `check`, with no lock, stops with `MDT-E1604` ("Module acme.connectors is
not known to this check"): that is the missing lock, not a fault of the program. Check it with the lock and the
configuration:

```sh
node bridge/dist/cli.js check fixtures/attention/invoices.mdt --lock "$S/invoices.lock.json" --config "$C"
```

It prints `ok` and the program's hash.

## Step 4. Read the card

```sh
node bridge/dist/cli.js view fixtures/attention/invoices.mdt --card --workflow MatchInvoices --lock "$S/invoices.lock.json" --config "$C"
```

This is the page ana approves. Read "What it can touch", "The most it spends" and "When it asks whom". The card says
"At most 2 questions in all (asks: 2)": a day for the accountant, then the finance lead, then every open item declined
by nobody.

## Step 5. Who wrote the program (the authoring row)

The first row of the acceptance is that an author builds the workflow with an agent that cannot approve it. **In the
scripted variant of this guide that row is NOT shown by this session.** The program is the fixture
`fixtures/attention/invoices.mdt`, written beforehand; nothing here wrote it, and nothing here checked that an agent
could. Only the real-agent variant shows the row:

1. Make the agent's workspace: a new, empty directory outside this repository and outside the session directory. Copy
   into it the lock `$S/invoices.lock.json` and the directory `$S/libraries` (it holds only the library the lock pins,
   `acme.connectors/2.3.0`, with its three files `mandate.library.json`, `connectors.mdt` and `types.mdt`). The
   workspace then holds `invoices.lock.json` and `libraries/acme.connectors/2.3.0/`. Copy nothing else: in particular
   not `$S/people`, which holds the keys.
2. In a third terminal (not B), start the agent's MCP client in that directory and configure two things, nothing else:
   the Mandate server as a stdio server with the command `node` and two arguments, the absolute path of this
   repository's `bridge/dist/cli.js` and `mcp` (your client's own configuration says where they go), with all of the
   tools it offers enabled (`mandate.check`, `mandate.project`, `mandate.explain`, `mandate.apply_patch`,
   `mandate.caps_of`, `mandate.spec`; the server also supplies the embedded `std.patterns`); and a file tool that
   reads and writes the workspace only. It has no shell and no key.
3. Send it this request, whose names are the ones the later steps use. It says what is wanted and none of how to write
   it; the agent finds that in the specification (`mandate.spec`) and the library files:

   ```text
   Write a Mandate program, language 0.7, in the file invoices.mdt in this directory.

   It has one workflow, named MatchInvoices, and two roles: accountant ("Accountant") and finance_lead ("Finance
   lead"). The workflow reads the invoices in the mailbox, matches each one to an open order of the same vendor, and
   posts each match to the ERP as a draft invoice, with the invoice number as the key that makes a repeated post
   harmless. An invoice is matched when the match is for that invoice, names an order of the invoice's own vendor, and
   the invoice's total is within 2% of the order's total. A larger gap in the total may be accepted by the accountant
   or by the finance lead. A match to an order of another vendor may be accepted by no one: it is declined without
   asking anyone.

   The accountant owns the workflow: the accountant approves its card and promotes it. The accountant is asked once, in
   one decision about at most 60 items, to waive or decline the invoices that missed only on the total, and has one
   day to answer. If the day passes unanswered, the same open items go to the finance lead, who has one more day for
   one decision of their own. If that day passes too, every open item is declined, by nobody, and the workflow goes on
   and posts what was accepted. The workflow may ask at most two questions in all, and may spend at most 20 USD and 2
   hours. The matching of one invoice is done by an agent named Matcher that may read the ERP's open orders and use a
   standard-tier model with data up to confidential, writes nothing, and may use at most 60k tokens, 0.30 USD and 4
   steps for one invoice. The workflow may use only these connector tools: the mailbox's list_invoices, and the
   ERP's list_open_orders and post_draft_invoice.

   It uses the library acme.connectors, whose files are in libraries/acme.connectors/2.3.0 (read them), and the lock
   invoices.lock.json pins it. Check the program with the tool mandate.check until it reports no diagnostic. Give the
   tool: source, the full text of invoices.mdt; lock, the contents of invoices.lock.json parsed as JSON and given as
   an object, not as a string; and libraries, an array of one object, { "manifest": the full text of
   mandate.library.json as a string, "files": { "connectors.mdt": its full text, "types.mdt": its full text } }.
   Without the lock and the library the check cannot find the library's modules.

   When the check is clean, call the tool mandate.project twice for the workflow MatchInvoices, once with view "card"
   and once with view "attention", each with the same source, lock and libraries, and show me both results as they
   are returned, with the final text of invoices.mdt. You cannot sign, approve or promote anything.
   ```

   The agent can explain a finding, project a view and propose a patch. It cannot sign, approve or promote: those are
   the persons' (steps 6 to 9).
4. Keep what the agent produced as the evidence for row 1: the final source in `invoices.mdt`, the result of its last
   `mandate.check`, and the card and the attention view `mandate.project` returned. The participant reads them against
   the request: the workflow and role names, the owner, who is asked what and in which order, the two one-day
   deadlines, what follows when both pass, the bound of two questions, and the connectors' tools. Write down what the
   agent actually built, including every difference from the request. A clean check alone is not the evidence: a
   different program can check cleanly. (The specification's scripted rehearsal also shows a draft with a deliberately
   wrong bound, its diagnostic and a patch; that is the rehearsal's evidence, and this request does not ask the agent
   for it.)
5. The agent's program does not enter the next steps. Steps 6 and following run on the fixture, as printed, with the
   lock you made, so their success is no evidence about what the agent wrote.

Mark the authoring row in the checklist as "not shown" unless you did this, and as "pass" only for what the evidence in
point 4 shows.

## Step 6. The accountant approves the card

Before ana approves, nothing runs:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id u0 --lock "$S/invoices.lock.json" --mode design --config "$C"
```

It stops with `unapproved_envelope`. Ben cannot approve it: this is the same command with his own key, and it stops with
`not_in_role`:

```sh
node bridge/dist/cli.js approve-envelope fixtures/attention/invoices.mdt --key "$S/people/ben/ben.key" --lock "$S/invoices.lock.json" --config "$C"
```

Ana can:

```sh
node bridge/dist/cli.js approve-envelope fixtures/attention/invoices.mdt --key "$S/people/ana/ana.key" --lock "$S/invoices.lock.json" --config "$C"
```

(PowerShell shows a refusal as red text. That is the runtime's own message, not a crash.)

## Step 7. The design run

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id d1 --lock "$S/invoices.lock.json" --mode design --config "$C"
```

A design run reads sample data and writes nothing. It stops waiting: two items failed a criterion that a person may
waive. Look at what ana is asked:

```sh
node bridge/dist/cli.js waits --member ana --config "$C"
```

`waits` shows two labelled match values, each with an invoice number and an order. When you select the review in `decide` (next), it shows the original item numbers, 2 and 5, and the
unmet `totals` criterion of each. The invoice matched to another vendor's order is not in the review: it is declined
without asking. Now ana decides, with her own key. There are three ways to do it, and you
run one of them. Either the guided one, which asks you:

```sh
node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

Answer `1` to "Which one?", then `waive 2 decline 5` to "Decide every open item", then `y` to "Sign and submit?". Or, to
type nothing, the scripted form, in PowerShell:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

or, in a POSIX shell:

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

It prints `decision` and `signed by ana: waive 2, decline 5`, and the run is now succeeded (`run d1 is now succeeded`).
Look at the ERP: there are no posts, and there must be none.

```sh
node scripts/live-session.mjs drafts --session "$S"
```

## Step 8. Promote to read_only, and run there

Ben may not promote, because a promotion is the owner's:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key "$S/people/ben/ben.key" --yes --config "$C"
```

(It stops with `not_in_role`.) Ana promotes. Run this block alone, and wait for it to end before the next one; it
prints `promoted by ana as accountant`:

```sh
node bridge/dist/cli.js promote d1 --to read_only --key "$S/people/ana/ana.key" --yes --config "$C"
```

Then the run in read_only mode, which reads the fakes and still writes nothing:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r1 --lock "$S/invoices.lock.json" --mode read_only --config "$C"
```

(If the promotion was skipped, this run stops with `unpromoted` and no run `r1` exists: `decide` then finds nothing
waiting, and `shadow-diff` and `promote` in step 9 say `unknown_run` for `r1`.)

The run stops waiting for the same two items. Ana decides it, as in step 7, with one of the three ways. Either the
guided one: check that choice 1 names `r1`, then answer `1`, `waive 2 decline 5` and `y`:

```sh
node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

or, in PowerShell, the scripted one:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

or, in a POSIX shell:

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

It prints `run r1 is now succeeded`. Then check that nothing was written:

```sh
node scripts/live-session.mjs drafts --session "$S"
```

## Step 9. The shadow diff, and promote to live

What would the live run do that the design run did not?

```sh
node bridge/dist/cli.js shadow-diff d1 r1 --config "$C"
```

The diff lists six `erp.post_draft_invoice` rows marked `only_b`: the six posts `r1` would apply (five that matched and
one that ana waived). `d1` lists its simulated posts in its result, not as actions of its journal. Neither run posted
anything to the ERP: both committed zero posts. Ana promotes to live, signing the digest of this comparison (the
promotion prints `erp.post_draft_invoice: 6 would apply`):

```sh
node bridge/dist/cli.js promote r1 --to live --key "$S/people/ana/ana.key" --yes --config "$C"
```

## Step 10. The live run

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id l1 --lock "$S/invoices.lock.json" --mode live --config "$C"
```

`tick` is what a deployment's driver does every few seconds: it moves overdue waits and sends the notifications.

```sh
node bridge/dist/cli.js tick --config "$C"
```

```sh
node bridge/dist/cli.js waits --member ana --config "$C"
```

```sh
node bridge/dist/cli.js watch --member ana --out "$S/pages" --config "$C"
```

Open `pages/l1.accountant.html` in the session directory in a browser: this is the page ana is shown. Then decide, as
in step 7, with one of the three ways. Either the guided one:

```sh
node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

or, in PowerShell, the scripted one:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

or, in a POSIX shell:

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

Then tick again, so that the outcome is notified:

```sh
node bridge/dist/cli.js tick --config "$C"
```

```sh
node scripts/live-session.mjs drafts --session "$S"
```

There are six posts, of six different invoices: the five that matched and item 2, which ana waived. Item 5 was declined
by ana, and item 6 was declined automatically for the vendor mismatch; neither was posted.

Keep `pages/l1.accountant.html` as the waiting page you opened, and do not write the pages again before step 14: row 4
inspects that page. What ana may see of the run is its stream, which lists its events, each with a `class`:

```sh
node bridge/dist/cli.js watch l1 --role accountant --jsonl --config "$C"
```

What she is told: the notifications addressed to her in `$S/notifications.jsonl`, one JSON line for each, each with a
`class` too.

**A second live run posts the same invoices again.** Do not run another live run of this program in this session unless
you want to see that. The operation key the runtime sends the ERP as the idempotency key is made from the tenant, the
run, the workflow's node, the effect and the value of `idempotent_by` (the invoice number): it belongs to the run. The
same invoice in another run is another key, and a server that honours the key (the fake ERP does) applies it as another
post. The idempotency the specification promises is for a run and its retries and resumes: the same key sent again is
one post (`sent` above 1 in `drafts`). It does not promise that an invoice is posted once across runs; the card's "idempotent
by invoice_no" is to be read that way. An ERP that must refuse a second draft of an invoice has to do so itself. If you
want to see it, do it only after you have recorded the six posts above and inspected ana's waiting page (so that
nothing you inspect changes), and run these three commands: the second live run, ana's decision on it (the same
answers as for `l1`: choice 1 names `l2` now, then `waive 2 decline 5` and `y`; the scripted forms of step 7 work with
ana's key) and the posts:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id l2 --lock "$S/invoices.lock.json" --mode live --config "$C"
```

```sh
node bridge/dist/cli.js decide --key "$S/people/ana/ana.key" --config "$C"
```

```sh
node scripts/live-session.mjs drafts --session "$S"
```

`drafts` then shows twelve posts of six invoices, each of them twice, and the tool says so. This is a question for the
product's owner, not a defect of the kit.

## Step 11. The `asks` bound

The workflow may ask at most two questions in all. Three places show it: the card ("At most 2 questions in all (asks: 2)",
step 4), the count in the run:

```sh
node bridge/dist/cli.js status l1 --config "$C"
```

(the `budget asks:` line: the limit is 2, and the settled count is within it), and a start that would be allowed more
than the limit is refused:

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id x1 --lock "$S/invoices.lock.json" --mode design --limit asks=1 --config "$C"
```

It stops with `attention_above_asks`: it can ask two questions and was given room for one.

## Step 12. The deadline

A deadline passes without anyone answering, and the question goes to the next person. Two runs show the two ends of it:
in `r2` ben takes the question over and answers it; in `r3` nobody answers and both deadlines pass. Both use read_only,
so that nothing is posted twice (see the box in step 10), and the days pass without waiting for them. `advance` moves
the session's clock, for every `mandate` command of terminal B, by the duration (`90m`, `25h`, `2d`); it never goes
back. The program's own deadline (one day) is unchanged.

### 12a. `r2`: ben takes the question over

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r2 --lock "$S/invoices.lock.json" --mode read_only --config "$C"
```

```sh
node bridge/dist/cli.js tick --config "$C"
```

This first `tick` sends ana the question (look at `notifications.jsonl`: a `review_requested` for `r2` to the
accountant). Now ana's day passes, and the next `tick` moves the question on:

```sh
node scripts/live-session.mjs advance 25h --session "$S"
```

```sh
node bridge/dist/cli.js tick --config "$C"
```

```sh
node bridge/dist/cli.js waits --member ben --config "$C"
```

The question went to ben: `waits --member ben` lists `r2`, with the same two items as ana was asked about. He answers
it with his own key, in the same three ways as ana did in step 7 (run one of them). Either the guided one (answer `1`,
then `waive 2 decline 5`, then `y`):

```sh
node bridge/dist/cli.js decide --key "$S/people/ben/ben.key" --config "$C"
```

or, in PowerShell, the scripted one:

```powershell
"1","waive 2 decline 5","y" | node bridge/dist/cli.js decide --key "$S/people/ben/ben.key" --config "$C"
```

or, in a POSIX shell:

```sh
printf '1\nwaive 2 decline 5\ny\n' | node bridge/dist/cli.js decide --key "$S/people/ben/ben.key" --config "$C"
```

It prints `signed by ben: waive 2, decline 5` and `run r2 is now succeeded`. Read the final state:

```sh
node bridge/dist/cli.js status r2 --config "$C"
```

The run is succeeded. `status` lists the decisions the run stands on: ana's approval of the card (`decision envelope by
ana as accountant: signed`) and her promotion (`decision promote by ana as accountant: signed`), which every read_only
run starts under, and then `decision review by ben as finance_lead: signed`: the question was answered by the person it
went to when ana's day passed.

### 12b. `r3`: both deadlines pass

```sh
node bridge/dist/cli.js run fixtures/attention/invoices.mdt --workflow MatchInvoices --input '{}' --run-id r3 --lock "$S/invoices.lock.json" --mode read_only --config "$C"
```

```sh
node bridge/dist/cli.js tick --config "$C"
```

Nobody answers this one. Ana's day passes, and the question goes to ben:

```sh
node scripts/live-session.mjs advance 25h --session "$S"
```

```sh
node bridge/dist/cli.js tick --config "$C"
```

Ben's day passes too, and the deadline of the last person ends the question:

```sh
node scripts/live-session.mjs advance 25h --session "$S"
```

```sh
node bridge/dist/cli.js tick --config "$C"
```

```sh
node bridge/dist/cli.js status r3 --config "$C"
```

The run is succeeded, with every open item declined by nobody (`"by":null`): items 2 and 5, the two that were asked
about. Item 6 also shows `"by":null`, but it was declined for the vendor mismatch before any question, so it says
nothing about the deadlines. The only `decision` lines are ana's approval of the card (`decision envelope …`) and her
promotion (`decision promote …`). There is no `decision review` line: nobody signed the question.

## Step 13. Replay

Replaying a run recomputes it from its journal. The design and the live run give the same result as the run did:

```sh
node bridge/dist/cli.js status d1 --config "$C"
```

```sh
node bridge/dist/cli.js replay d1 --config "$C"
```

```sh
node bridge/dist/cli.js status l1 --config "$C"
```

```sh
node bridge/dist/cli.js replay l1 --config "$C"
```

Each `replay` says `replay: complete` and prints the result; the JSON is the `result:` that `status` printed. The
read_only run is a known limit:

```sh
node bridge/dist/cli.js replay r1 --config "$C"
```

It says `replay: partial`, stopping at the first write: the journal of `r1` holds a `would_apply` action there, and
replay needs a confirmed action to give back its receipt. That is how it is, not a failure of this session.

## Step 14. The result checklist

Go through it with the session still up. Write pass, fail or not shown, and a note, for each row.

| # | Row of the acceptance | What to look at | Verdict | Notes |
|---|---|---|---|---|
| 1 | An author builds the workflow | Step 5. Scripted variant: **not shown** (the program is the fixture). Real-agent variant: keep the agent's source, its last clean `mandate.check`, its card and its attention view as the evidence, and read them against the request (workflow, roles and owner, who is asked what and in which order, the two deadlines, what follows when both pass, the bound of two questions, the connectors' tools); write down what it actually built. Steps 6 onward run the fixture, not the agent's program. | | |
| 2 | The card is approved by the owner | Step 6: `unapproved_envelope` before; ben's approval `not_in_role`; ana's approval signed. | | |
| 3 | design, then read_only, then live | Steps 7 to 10: no post after design and read_only; a promotion by ana for each; the shadow diff of step 9 (six `only_b` rows); six posts after live. | | |
| 4 | The role sees only what it may be shown | Three statements, checked below the table, over what each role is shown: (a) no event of class S3 or S4 is in any role's stream, judged by the event's type and not only by the class printed on it; (b) every value shown carries a `class` and a `known` label, in the streams, the waits, the decision screens and the pages; (c) no value above the role's class in `role_classes` is shown unmasked. | | |
| 5 | Notifications carry only S0 and S1 | One statement with three parts, checked below the table, over every original line of `$S/notifications.jsonl`: (a) its event is one of the four S0 events or the six S1 events, with the matching class; (b) its members are exactly the payload's, `as_of` included; (c) no value of any command's result appears in it, as a substring of its text. | | |
| 6 | The `asks` bound holds | Step 11: the card's "At most 2 questions in all (asks: 2)"; the `budget asks:` line of `status l1`; the refused start with `--limit asks=1`. | | |
| 7 | A missed deadline escalates | Step 12. For `r2`: a `review_escalated` event for `finance_lead` in his stream, `waits --member ben` listing `r2`, ben's signed review (`signed by ben`; `decision review by ben as finance_lead: signed` in `status r2`) and `status r2` succeeded. For `r3`: in `status r3`, items 2 and 5 declined with `"by":null`, the run succeeded and no signed review (no `decision review` line). Item 6 is declined with `"by":null` for the vendor mismatch whatever happens to the deadlines, so it is no evidence. | | |
| 8 | Replay is equal | Step 13: `replay d1` and `replay l1` complete with the result `status` printed; `replay r1` is `partial` (a known limit). | | |

Rows 4 and 5 are the specification's four checkable statements (spec/attention.md, Acceptance: "It finishes seeing only
S0 to S2"), over what the participant read. They are judged on what each role is shown (its stream, its waits, its
decision screen, its page, the notifications addressed to it), not on the operator's own output (`run`, `status`,
`drafts`, `replay`, `tick`), which is not a role's view (see "Who operates and who judges", at the top).

Row 4, what the roles are shown. The two streams, the accountant's `l1` and the finance lead's `r2`, each event with its
`class`:

```sh
node bridge/dist/cli.js watch l1 --role accountant --jsonl --config "$C"
```

```sh
node bridge/dist/cli.js watch r2 --role finance_lead --jsonl --config "$C"
```

- (a) No S3 or S4 event. For each event in both streams, look up its `type` in the Events table of `spec/boundary.md`
  (the class of every event type the runtime writes). The class the table gives must be S0, S1 or S2, and the printed
  `class` must be the same one. An event whose type the table puts in S3 or S4 is a fail even if its printed `class` says
  otherwise, and so is an event whose printed `class` differs from the table's: the printed field is what is under test,
  so it cannot vouch for itself.
- (b) Every value carries both labels. In the streams, look at the values in the wait requests (`wait_opened`) and in
  every report field (`report` events; this fixture reports "Items collected" and "Batch done"). Then in each `waits`
  and `decide` screen and each role page the participant read (steps 7, 8, 10 and 12; `pages/l1.accountant.html`),
  look at every question value and every report field, including the page's Class and Known columns. A value of a
  listing ends with `[class …; known …]`; the page prints a value with a note, "Its class …, known …". Record a failure
  for any bare value, including one outside a labelled field.
- (c) Nothing above the role's class is unmasked. For each role compare the class of every value it was shown with that
  role's entry in `role_classes` in `$S/invoices.lock.json` (both roles are `confidential`). A value above the cap must
  be masked: `masked; its class is …` in a listing, "Masked: its class is …" on a page. Fail if any value above the
  cap is visible. If every visible value is within the cap, (c) passes for these observations; the fixture's values
  are `confidential`, so nothing here is above the cap and masking itself is not exercised: write "No above-cap
  value occurred in this fixture" in the notes.

Row 5, what the notifications carry. Read every original JSON line of `notifications.jsonl` in the session directory
(one line for each notification), not a summary of them. A summary of classes alone cannot establish a pass.

- (a) The event. Each line's `event` is one of the four S0 events `wait_opened`, `review_requested`,
  `review_escalated`, `amendment_requested`, with `class` `S0`, or one of the six S1 events `run_succeeded`,
  `run_failed`, `run_cancelled`, `run_attention_required`, `budget_exceeded`, `asks_exhausted`, with `class` `S1`. Any
  other event, or a class that does not match its event, is a fail.
- (b) The members. The members of each line are exactly these sixteen and no others: `format`, `id`, `kind`, `event`,
  `class`, `tenant`, `run`, `workflow`, `package`, `seq`, `at`, `role`, `command`, `deadline`, `as_of`, `link`; and
  `as_of` holds exactly `revision` and `event`.
- (c) No result value in the text. Compare the whole line, the text inside every member included, with what the
  commands returned. Get the values from the operator's listings of the invoices, the orders and the posts:

```sh
node scripts/live-session.mjs inbox --session "$S"
```

```sh
node scripts/live-session.mjs orders --session "$S"
```

```sh
node scripts/live-session.mjs drafts --session "$S"
```

None of their values may appear anywhere in a line, as a substring: an invoice number, an order number, a vendor, an
amount or a returned draft id. Search the file for each value; no output means it is absent. Either in PowerShell
(replace VALUE by the value, and repeat):

```powershell
Select-String -Path "$S/notifications.jsonl" -SimpleMatch -Pattern 'VALUE'
```

or in a POSIX shell:

```sh
grep -F 'VALUE' "$S/notifications.jsonl"
```

Record every line that violates any part of (a), (b) or (c).

## Step 15. Stop and clean up

First end the session's clock in terminal B. Either in PowerShell:

```powershell
Remove-Item Env:NODE_OPTIONS
```

or in a POSIX shell:

```sh
unset NODE_OPTIONS
```

Then:

```sh
node scripts/live-session.mjs status --session "$S"
```

```sh
node scripts/live-session.mjs down --session "$S"
```

```sh
node scripts/live-session.mjs clean --session "$S"
```

`down` stops the world (Ctrl+C in terminal A does too) and keeps the directory; `clean` removes what the kit made in it,
with the keys and the store, and the directory if nothing else is in it (otherwise it lists what it left). It refuses a
directory that is not the kit's session, or that is inside a git work tree. The agent's workspace of step 5 is not the
kit's: delete it yourself.

## What this session does not show

About the product, which a pass here does not cover:

- A promotion binds the package and the workflow, not a store. Using it in a second store needs signing keys that store
  trusts and the reconstruction of the prerequisite runs and signed records the specification describes under
  "Promotion".
- Reading is not authenticated: a caller names its own role (`--role`, `--member`); only a signature is evidence.
- Replaying a read_only run returns `partial`.
- A new notification channel is told no history: it starts with the waits open at that time and the runs that already
  need a person, then receives the events that follow.
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
from a `.env` (the kit reads none), and is not shown as you type it. Either in PowerShell:

```powershell
$k = Read-Host "key" -AsSecureString
```

and, once you have typed the key and pressed Enter:

```powershell
$env:CLAUDE_API_KEY = [System.Net.NetworkCredential]::new('', $k).Password
```

or in a POSIX shell:

```sh
read -s CLAUDE_API_KEY && export CLAUDE_API_KEY
```

Then, in the same terminal A:

```sh
node scripts/live-session.mjs up --real-model
```

This `up` is step 1 with a real model in place of the simulated one, not a step after it: run it instead of the plain
`up`, and carry on from step 2 with the lines it prints. From there the guide's fixed answers do not apply blindly: step
2 reports `model real`, and a real Matcher can return another match or fail a skill. Read each actual wait before you
decide, use the item numbers it shows instead of `waive 2 decline 5`, and record the outcomes (the posts, the counts) you
observe instead of the quoted ones. A world that is already running (started without
`--real-model`) keeps its simulated model: stop it first (Ctrl+C in its terminal).

The runtime's own configuration is used: the model's host is the one thing besides the two fakes the egress proxy lets
through, with the key held by the proxy. Terminal B must not have the key. The agent loop also needs the sandbox the
runtime's operating system has (Windows and Linux only). Without the key, `up --real-model` stops and says so. This
path has not been run by the kit's authors: it is checked by its configuration and by reading.

## When something goes wrong

- `the session's world is not running`: terminal A has stopped or crashed; run `up` again with `--dir` set to the same
  directory. That keeps the recorded runs, the keys, the clock and the notifications, but the fake ERP starts empty each
  time: if the world stopped after a live post, start a fresh session for the post count and the duplicate-post check,
  or they will be wrong.
- `…/runtime/dist/… is not there`: build first (`npm run build`).
- A compiler failure at once: `bridge/wasm` is missing (`npm run build:wasm`).
- `MDT-E1604` from `check` ("Module acme.connectors is not known to this check"): the check was run without the lock
  and the configuration. Give it both: `--lock "$S/invoices.lock.json" --config "$C"` (step 3). An agent's `mandate.check`
  needs the `lock` and `libraries` parameters for the same reason (step 5).
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
