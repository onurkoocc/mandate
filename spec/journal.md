# The chained journal, 0.5

Status: implemented in the reference runtime (`runtime/src/journal-chain.ts`).

A run's journal is the append-only list of its events in the database
(`events`, [`runtime.md`](runtime.md#storage)). Replay and the views are
derived from it. This document makes the journal tamper-evident and says,
byte for byte, how an outsider checks it:

- each event of a run carries a hash over its contents and the hash of the
  event before it, so the events form a chain;
- at every state change the runtime signs an *anchor* over the chain with
  its evidence key;
- a run can be exported with what an outsider needs;
- a verifier that reads only the export and public keys says whether the
  chain holds, and what the signatures cover.

It is written so a second implementation of the verifier can be built from
it and from the cases J01–J08 alone. Where it says "the reference", it
means the TypeScript runtime.

## What it proves, and what it does not

The chain is evidence against someone who can write to the database but
does not hold the runtime's evidence key. Such a person cannot edit, remove,
insert or reorder an event that an anchor covers, or forge an anchor,
without a verifier saying where.

It is not more than that:

- **Whoever holds the database and the key** can rewrite a journal: hash
  the events again and sign new anchors. The key is the root of the claim.
- **The tail after the last anchor is covered by no signature.** Events
  written since the last state change can be changed or cut, without a
  trace, until the next state change anchors them. The report says how far
  the signatures reach (`anchored_through`) and how many events come after.
- **Anchors are in the same database.** Someone who holds it can delete the
  newest events together with their anchors. The journal then reads as one
  that stopped at an earlier anchor, and verifies that far. Only a witness
  outside the database shows the cut: an export taken earlier and kept
  elsewhere, and later the OpenTelemetry projection (spec/boundary.md). The
  export is that witness; the runtime keeps no copy of it.
- **A chained run can be made to read as unchained** by removing every hash
  and every anchor. `unchained` is never `verified`: a reader who knows the
  run began after the chain treats `unchained` as broken.
- **Nothing on a read path checks the chain.** `events()`, replay and the
  views read the journal as it is. The chain is checked when a run is
  exported and verified (`mandate journal verify`, `Runtime.verifyJournal`).
- **The export carries the package the run began under.** A package an
  amendment moved the run to is named by hash in `package_amended`, which the
  chain covers; its content is not in the export and is not checked.
- **Decisions and evidence are not in the export.** They carry signatures of
  their own (`mandate verify-decision`, [`envelope.md`](envelope.md)).

## The canonical form of a runtime value

Event data, manifests and statements are JSON values: null, booleans,
numbers, strings, arrays and objects. Their canonical form is RFC 8785
(JCS) over those values, which is also what the reference's `canonical`
(`runtime/src/values.ts`) writes:

- **No whitespace** anywhere.
- **`null`, `true`, `false`** as written.
- **A number** is an IEEE 754 double, written as ECMAScript's
  `Number::toString` writes it (RFC 8785 §3.2.2.3). For a finite `x`:
  - `0` for +0 and for -0;
  - for `x < 0`, `-` followed by the form of `-x`;
  - otherwise let `s`, `k`, `n` be the integers with `k >= 1`,
    `10^(k-1) <= s < 10^k`, `s * 10^(n-k) = x` and `k` as small as possible
    (the shortest digits that read back as `x`; when two such `s` exist, the
    one closer to `x`). Then:
    - `k <= n <= 21`: the `k` digits of `s`, then `n - k` zeros
      (`100`, `123456789012345680000`);
    - `0 < n <= 21`: the first `n` digits, `.`, the other `k - n`
      (`123.456`);
    - `-6 < n <= 0`: `0.`, then `-n` zeros, then the `k` digits
      (`0.1`, `0.000001`);
    - otherwise `k = 1`: the digit, `e`, `+` or `-`, and `|n - 1|`
      (`1e+21`, `1e-7`, `5e-324`);
    - otherwise: the first digit, `.`, the other `k - 1` digits, `e`, the
      sign and `|n - 1|` (`1.7976931348623157e+308`, `-2.5e-8`).

  Integers are not special: `9007199254740993` is not a double and reads as
  `9007199254740992`, and is written so.
- **A string** is written as ECMAScript's `JSON.stringify` writes it: `"`,
  then each code point, then `"`. `"` and `\` are written `\"` and `\\`;
  U+0008, U+0009, U+000A, U+000C and U+000D are written `\b`, `\t`, `\n`,
  `\f` and `\r`; every other code point below U+0020 is written `\u`
  and four lowercase hex digits (U+001F is `\u001f`). Every other code
  point is written as itself, in UTF-8: `/`, U+007F, U+2028 and U+2029 are
  not escaped. No Unicode normalization: `é` and `e` followed by U+0301 are
  different strings.
- **An array**: `[`, its elements' forms joined by `,`, `]`.
- **An object**: `{`, its members joined by `,`, `}`. A member is its name
  (a string, written as above), `:`, and its value. Members are sorted by
  their names as sequences of **UTF-16 code units**, compared unit by unit,
  a shorter name before a longer one it begins. This is not code point
  order: an astral character (UTF-16 `D83D DE00` for U+1F600) sorts before
  U+FF21, whose code unit is greater, though its code point is smaller.

The digest of a value in a domain `<d>` is `sha256:` followed by the 64
lowercase hex digits of SHA-256 over the UTF-8 bytes of `mandate/<d>/0.1`,
a line feed (U+000A), and the value's canonical form.

What cannot occur in a value the runtime hashes:

- U+0000 and lone surrogates: the database refuses a string with one, so
  the event is never written (`runtime/test/journal-hash.test.ts`);
- NaN and the infinities: `JSON.stringify` writes them as `null`, and the
  hash is over what was stored;
- `undefined`: a member whose value is `undefined` is dropped before the
  hash, as it is before the event is stored.

## The event hash

An event of a chained run has a hash:

```text
hash = digest("event", { "run": run, "seq": seq, "type": type, "data": data, "at": at, "prev": prev })
```

- `run`: the run id, a string.
- `seq`: the event's number, an integer from 1.
- `type`: the event's type, a string such as `run_accepted`.
- `data`: the event's data, a JSON value, **as the database gives it back**.
  The runtime computes the hash over `JSON.parse(JSON.stringify(data))`,
  which is the stored value: the property test in
  `runtime/test/journal-hash.test.ts` writes random data through the
  journal on PGlite and on PostgreSQL and finds the hash recomputed from what
  comes back is the stored one. The hash is over the value, not over the
  stored text, whose member order and number spelling the database chooses.
- `at`: the time the event was stored, milliseconds since the Unix epoch,
  an integer.
- `prev`: the hash of the event before, a string; `null` at seq 1.

So the bytes hashed are, with the members in canonical order:

```text
mandate/event/0.1
{"at":<at>,"data":<data>,"prev":<prev>,"run":<run>,"seq":<seq>,"type":<type>}
```

Two events of run `r1`:

```text
mandate/event/0.1
{"at":1800000000000,"data":{"limits":{"spend:USD":1000000},"workflow":"Ask"},"prev":null,"run":"r1","seq":1,"type":"run_accepted"}
```

hashes to
`sha256:95c8de5afdb66c9d9227bd744e2682a7b4f40d799b5a6bfd71880a036774b778`, and

```text
mandate/event/0.1
{"at":1800000000250,"data":{"a":null,"😀":[0.1,0,1e+21,1e-7,"é\n"],"Ａ":1},"prev":"sha256:95c8de5afdb66c9d9227bd744e2682a7b4f40d799b5a6bfd71880a036774b778","run":"r1","seq":2,"type":"probe"}
```

(its data was `{ "Ａ": 1, "😀": [0.1, -0, 1e21, 1e-7, "é\n"], "a": null }`;
`Ａ` is U+FF21) hashes to
`sha256:631a160101da7d8c9b09f13dc47118c3818d3c6c4bb0c74b9d56815d42287c3a`.
The data's canonical form alone is the UTF-8 bytes
`7b2261223a6e756c6c2c22f09f9880223a5b302e312c302c31652b32312c31652d372c22c3a95c6e225d2c22efbca1223a317d`.

### Which runs are chained

A run is chained when its first event has a hash. The runtime decides it
when it appends (`Journal.event`): it reads the run's last event, and
hashes the new one when there is no event yet or the last one has a hash.
So every run begun since the chain is chained from seq 1, and a run begun
before it keeps writing events without a hash. Appending is one read of the
last event and one insert, under the run's row lock (`select … for update`)
or in the transaction that creates the run, so two appends to one run never
interleave.

## Anchors

At every state change the runtime writes the state event (`run_<state>`)
and, in the same transaction, an anchor over it. The state events are
`run_accepted` (written when the run is created), `run_running`,
`run_waiting`, `run_cancelling`, `run_attention_required`, `run_succeeded`,
`run_failed` and `run_cancelled`. An anchor is a row of `journal_anchors`,
never an event. An unchained run has nothing to anchor.

An anchor signs this statement:

```json
{ "format": "mandate/journal-anchor/0.1", "run": "<run id>", "seq": <the state event's seq>, "hash": "<its hash>", "at": <its at> }
```

with the runtime's evidence key, the key that signs evidence records
([`runtime.md`](runtime.md#evidence-records-103)):

- **What is signed:** the UTF-8 bytes of `mandate/journal-anchor/0.1`, a line
  feed, and the statement's canonical form. For the first event above:

  ```text
  mandate/journal-anchor/0.1
  {"at":1800000000000,"format":"mandate/journal-anchor/0.1","hash":"sha256:95c8de5afdb66c9d9227bd744e2682a7b4f40d799b5a6bfd71880a036774b778","run":"r1","seq":1}
  ```

- **How:** Ed25519 (RFC 8032, pure Ed25519: no prehash, no context).
- **The signature** is stored as `ed25519:` followed by the standard base64
  (RFC 4648 §4, with `=` padding) of the 64 signature bytes: 88 characters
  after the prefix, ending in `==`. Only the canonical encoding counts: the
  unused low bits of the last character before `==` are zero.
- **The key id** is `sha256:` followed by the lowercase hex SHA-256 of the
  public key's SubjectPublicKeyInfo DER. For an Ed25519 key that DER is the
  12 bytes `30 2a 30 05 06 03 2b 65 70 03 21 00` followed by the 32-byte
  public key. A public key is written as PEM: `-----BEGIN PUBLIC KEY-----`,
  the base64 of that DER in lines of 64 characters, `-----END PUBLIC KEY-----`.

The anchor row holds the run, `seq`, `hash`, `at`, `key_id` and `signature`.
A key rotated out (`mandate rotate-key`) stays trusted, so anchors it signed
still verify; `mandate journal key` writes it with the current one.

## The export

`mandate journal export <run>` and `Runtime.exportJournal(run)` read a run's
journal out of the database as it is, checking nothing, into one JSON
document. Its members:

| Member | Value |
|---|---|
| `format` | `"mandate/journal-export/0.1"` |
| `run` | The run id, a non-empty string |
| `tenant` | The run's tenant, a string |
| `manifest_hash` | The run's manifest hash, a string, or `null` |
| `manifest` | The run's manifest, an object, or `null` ([`runtime.md`](runtime.md#workspace-and-run-manifest-design-doc-9-12-b3)) |
| `package` | `{ "hash", "program", "lock", "modules" }`: the package the first event names, its program's IR, its lock as packaged (without the `lock` format member) and the modules it was checked with, by name (`{}` when none) |
| `events` | Every event in seq order: `{ "seq", "type", "data", "at", "hash" }`, `hash` a string or `null` |
| `anchors` | Every anchor in seq order: `{ "seq", "hash", "at", "key_id", "signature" }` |
| `keys` | The key ids that signed the anchors, sorted, each once. Advisory: a verifier trusts the keys it is given, never these |

It carries no decision or evidence record. The reference writes it with two
spaces of indentation and a final line feed; a verifier reads it as JSON
values, so neither the layout nor the order of members matters.

`mandate journal key [--out FILE]` writes the public keys anchors are
verified against, as PEM blocks one after another: the evidence key's own
first, then the keys rotated out and the keys the configuration names under
`evidence.trusted`, by key id.

## Reading an export

A verifier reads an export as untrusted bytes. Anything that does not meet
these rules is `malformed_export`, and nothing else in it is read:

1. At most 64 MiB (67108864 bytes).
2. UTF-8, without a byte order mark.
3. One JSON text (RFC 8259): whitespace only space, tab, line feed and
   carriage return; no comments, no trailing commas, no leading zeros, no
   `+` sign, nothing after the value.
4. At most 128 arrays and objects nested in one another, the outermost
   object counting as one.
5. No object with two members of the same name. A name such as
   `__proto__` is a member like any other.
6. In strings, the escapes of RFC 8259 only. A lone surrogate, escaped
   (`\ud800` without a low surrogate escape after it) or not, is refused.
   An unescaped code point below U+0020 is refused.
7. A number is read as the double nearest to it, as `JSON.parse` reads it.
   One beyond the largest double (`1e400`) is refused; one below the
   smallest reads as 0. `-0` reads as -0, whose canonical form is `0`.
8. The shape, each object with exactly these members and no others:
   - the export: `format` (exactly `"mandate/journal-export/0.1"`), `run`
     (a non-empty string), `tenant` (a string), `manifest_hash` (a string or
     `null`), `manifest` (an object or `null`), `package`, `events`,
     `anchors`, `keys` (an array of strings);
   - `package`: `hash` (a string), `program`, `lock`, `modules` (objects);
   - `events`: an array of at least one event, each with `seq` (an integer
     from 1 up to 2^53 - 1), `type` (a string), `data` (any value), `at` (an
     integer of magnitude at most 2^53 - 1) and `hash` (a string or `null`);
   - `anchors`: an array of anchors, each with `seq` (as an event's),
     `hash`, `key_id` and `signature` (strings) and `at` (as an event's);
     each anchor's `seq` greater than the one before it.

## Verification

`mandate journal verify <export> --key <pem>…` and the reference's
`verifyExport(bytes, keys)` take the export and the public keys and nothing
else: no configuration, no database. `Runtime.verifyJournal(run)` is the
same over the export's bytes and the keys the runtime trusts.

Read the export (above). Then, with `events` and `anchors` in the order the
export gives them:

0. **Unchained.** If no event has a hash and there is no anchor, the report
   is `unchained` with no findings, and nothing more is checked. Otherwise
   the run is checked as chained, so a first event stripped of its hash is
   `hash_missing`, not `unchained`.
1. **Seqs.** The `i`-th event (from 1) must have `seq` `i`. At the first
   that does not: `seq_gap` with `seq` `i`. One finding at most.
2. **The chain.** With `prev` `null`, for each event in order: if its
   `hash` is `null`, `hash_missing` at its seq; otherwise, if its `hash` is
   not the event hash of `{run, seq, type, data, at, prev}`, with `run` the
   export's, `chain_broken` at its seq. Then `prev` is that event's `hash`
   as the export gives it, `null` included. So an edited event breaks at
   itself, and a removed or moved one at the event after it.
3. **The manifest.** Let *accepted* be the first event when its `seq` is 1,
   its `type` is `run_accepted` and its `data` is an object. `manifest_mismatch`
   unless there is an *accepted*, `manifest` is an object,
   `digest("run", manifest)` equals *accepted*'s `data.manifest`,
   `manifest_hash` equals it too, `manifest.tenant` equals `tenant`, and
   `manifest.package` equals *accepted*'s `data.package`.
4. **The package.** `package_mismatch` unless there is an *accepted*, and
   `package.hash`, and the package hash recomputed from `program` and
   `lock`, both equal *accepted*'s `data.package`, and each module in
   `modules` has `module` equal to its name and hashes to the pin
   `lock.modules[name]`. The package hash is
   `digest("package", { "program": P, "lock": lock })`, with `P` the program
   hash (`mandate/program/<v>`, [`ir.md`](ir.md#hashing)); a module's hash is
   its program hash. These use the IR's canonical form, which admits only
   integers of magnitude up to 2^53 - 1 (no -0): a program or lock with
   another number is a mismatch.
5. **Anchors.** For each anchor, in order:
   - if no key given has its `key_id`: `anchor_unknown_key`;
   - otherwise, if its `signature` is not a canonical `ed25519:` signature
     by that key over the statement `{format, run, seq, hash, at}` (with the
     export's `run` and the anchor's `seq`, `hash` and `at`):
     `anchor_signature_invalid`;
   - then, if its `seq` is greater than every event's: `anchor_beyond_end`
     (the tail was cut);
   - otherwise, if no event has its `seq`, or the first that does has
     another `hash` or `at`: `anchor_mismatch`.

   Each at the anchor's seq. An anchor **holds** when its key was given,
   its signature verifies and it matches its event. `anchored_through` is
   the greatest `seq` of an anchor that holds, or `null`; `signed_by` lists
   the key ids of the anchors that hold, sorted, each once.
6. **Anchors missing.** For each event in order whose `type` is a state
   event (above) and whose `seq` no anchor has: `anchor_missing` at its seq.
   Removing anchors never makes a tampered run clean: every state event of
   a chained run was anchored in the transaction that wrote it.
7. **The tail.** The events whose `seq` is greater than `anchored_through`
   (all of them when it is `null`) are covered by no signature. If there
   are any: `unanchored_tail` at the first one's seq.

The status is `broken` when there is any finding but `unanchored_tail`, and
`verified` otherwise.

### Why the tail is not broken

Events after the last anchor are normal. A run that goes on writes events
between state changes, and a run that ended can still get some: a worker
that comes to a finished run takes its lease (`lease_acquired`) before it
sees the run has ended, a refused decision is recorded, a charge arrives
late. So `unanchored_tail` alone leaves a run `verified`. It never widens
what `verified` says: the report names the last seq the signatures cover
and how many events come after it. Because every state event must carry its
anchor (step 6), the unanchored events are always events written after the
last state change; anything before it is covered.

## The report

```json
{
  "format": "mandate/journal-verification/0.1",
  "run": "j01",
  "status": "verified",
  "events": 10,
  "last_seq": 10,
  "anchored_through": 10,
  "unanchored": 0,
  "signed_by": ["sha256:…"],
  "findings": []
}
```

| Member | Value |
|---|---|
| `format` | `"mandate/journal-verification/0.1"` |
| `run` | The export's run id; `null` for a malformed export |
| `status` | `"verified"`, `"broken"` or `"unchained"` |
| `events` | How many events the export has; 0 for a malformed export |
| `last_seq` | The seq of the export's last event; `null` for a malformed export |
| `anchored_through` | The greatest seq of an anchor that holds; `null` when none does, and for an unchained or malformed export |
| `unanchored` | How many events have a seq greater than `anchored_through` (all of them when it is `null`); 0 for a malformed export |
| `signed_by` | The key ids of the anchors that hold, sorted |
| `findings` | `{ "code", "seq"? }` each, in the order the steps above find them |

A malformed export's report has the one finding `malformed_export` and the
status `broken`. The findings:

| Code | Seq | Means |
|---|---|---|
| `malformed_export` | none | The export cannot be read, or does not have the shape above |
| `seq_gap` | the first position whose event has another seq | An event was removed or moved |
| `hash_missing` | the event's | An event of a chained run has no hash |
| `chain_broken` | the event's | The event's hash is not that of its contents and the hash before it |
| `manifest_mismatch` | none | The manifest is not the one the first event names |
| `package_mismatch` | none | The package is not the one the first event names |
| `anchor_unknown_key` | the anchor's | The anchor's key is not among the keys given |
| `anchor_signature_invalid` | the anchor's | The anchor's signature does not verify |
| `anchor_beyond_end` | the anchor's | The anchor names an event past the last one: the tail was cut |
| `anchor_mismatch` | the anchor's | The anchor's hash or time is not its event's |
| `anchor_missing` | the event's | A state event has no anchor |
| `unanchored_tail` | the first event after `anchored_through` | No signature covers the events from here on |

`mandate journal verify` prints the status, each finding with what it
means, and how far the signatures reach; `--json` prints the report. It
exits 0 when the status is `verified`, 1 when it is `broken` or
`unchained`, and 2 on a usage error. A `--key` file may hold several PEM
blocks, and `--key` may be given more than once.

## Storage

| Table | Holds |
|---|---|
| `events.hash` | The event's hash; `null` in a run begun before the chain |
| `journal_anchors` | Per run and seq: the anchored event's `hash` and `at`, the `key_id` and the `signature` |

Both are added with `if not exists`, so a database of an earlier runtime is
upgraded in place, and its runs stay unchained.

## Conformance cases

`conformance/J01`–`J08` ([`conformance/README.md`](../conformance/README.md#a-journal-case))
each hold an export, the public key it is verified against and the report.
A verifier conforms when it gives each report exactly. They come from real
runs on PGlite (`runtime/scripts/journal-cases.mjs`).

| Case | Claim | Status |
|---|---|---|
| J01 | A closed run whose chain holds and whose anchors cover every event; one event's data holds fractions, exponents, -0, escapes and keys that sort differently by UTF-16 code units and by code points | `verified` |
| J02 | An event whose data was edited breaks the chain at that event | `broken`: `chain_broken` |
| J03 | A deleted event leaves a gap and breaks the chain after it | `broken`: `seq_gap`, `chain_broken` |
| J04 | A tail cut while its anchors stay | `broken`: `anchor_beyond_end`, `unanchored_tail` |
| J05 | An open run with events after its last anchor | `verified`, `unanchored_tail` |
| J06 | An anchor by a key not given and one whose signature does not verify | `broken`: `anchor_signature_invalid`, `anchor_unknown_key` |
| J07 | A manifest and a package not the ones the first event names | `broken`: `manifest_mismatch`, `package_mismatch` |
| J08 | A run begun before the chain | `unchained` |
