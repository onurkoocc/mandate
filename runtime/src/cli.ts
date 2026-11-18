// The control CLI (Doc 4 §16.1; BACKLOG K19): a person runs a program and
// answers it from a terminal. `mandate show` gives the run's views.
//
//   mandate run <program> --workflow W --input <json> [--run-id ID] [--limit spend=20USD,tokens=2M,asks=2]
//   mandate status <run> [--json]
//   mandate key new [--out FILE]                          a key of your own, to sign decisions with
//   mandate approve-envelope <program> --key FILE [--member NAME] [--workflow W]
//                                                         approve a package's envelope, so its runs may start
//   mandate approve <run> --revision N --key FILE [--member NAME]
//   mandate decline <run> --revision N --key FILE [--member NAME]
//   mandate answer <run> --revision N --key FILE [--member NAME] <text>
//   mandate review <run> --revision N --key FILE [--member NAME] [--waive I,J] [--decline K]
//                                                         decide a review of a batch (0.6): every open item, by its
//                                                         index, waived or declined, in one signed decision
//   mandate cancel <run> [--key FILE]
//   mandate reconcile <run> <operation> [--key FILE]      ask the system of record what an unknown outcome was
//   mandate raise-limits <run> --revision N --key FILE [--member NAME] --limit spend=30USD
//   mandate amend <run> --revision N --key FILE [--member NAME] (approve | decline)
//                                                         decide an amendment of the envelope a lead asked for
//   mandate decision <run> <digest>                       a decision the run took, as its signed record
//   mandate verify-decision <record.json> --key <public key.pem> [--lock FILE] [--waive I,J --decline K]
//                                                         check a decision's signature (and a review's, that it decided
//                                                         those items); no configuration, no database
//   mandate journal export <run> [--out FILE]            the run's journal as an outsider checks it (spec/journal.md)
//   mandate journal key [--out FILE]                      the public keys its anchors are signed with
//   mandate journal verify <export.json> --key <public key.pem> [--key …] [--json]
//                                                         check a journal's chain and anchors; no configuration, no database
//   mandate replay <run>
//   mandate halt (--tenant T | --all) [--reason TEXT] [--by WHO]   the hard stop: ends every open run of the scope
//                                                         and refuses its starts and resumes (spec/boundary.md)
//   mandate halt --lift (--tenant T | --all) --by WHO     lifts that scope's halts; no run comes back
//   mandate halt --list                                   every halt, in force or lifted
//   mandate otel export --endpoint URL [--run R | --tenant T] [--follow] [--json]
//                                                         the journal as OpenTelemetry spans, without content, posted to
//                                                         URL/v1/traces from each run's cursor; no credential is sent (spec/boundary.md)
//   mandate promote <run> --to read_only|live --key FILE [--member NAME] [--yes]
//                                                         the owner promotes the run's workflow up the ladder (0.7): shows
//                                                         the run, and for live its shadow diff as counts, asks, signs
//   mandate tick [--follow] [--interval 10s] [--no-notify]   the driver loop: deadlines pass, reviews escalate, then the
//                                                         notifications of 0.7 runs go out (spec/attention.md)
//   mandate artifact <run> <blob:sha256:…>
//   mandate show <run> [--format md|html|json]           the run's views (§15): status, evidence, cost, actions
//   mandate show <run> --role R | --audit                 what a role of the program may see of it; or everything, with
//                                                         its events and its chain's status (spec/boundary.md)
//   mandate rotate-key                                    a new evidence key; the old one's public half stays trusted
//   mandate denials <run>                                 what learning-mode sandboxes denied, for `mandate check --denials` (W0311)
//   mandate test <program> [--json]                       run the program's tests (§6.4); needs no configuration
//   mandate onboard --component name=dir…                 a draft system model from working copies (doc 9 §7); no configuration
//   mandate drift --module model --component name=dir…    where a system model and the working copies disagree; no configuration
//   mandate deploy <program> --target managed-agents      deploy the agents to Claude Managed Agents and write the binding
//                                                         into the lock (K45); CLAUDE_API_KEY; no configuration
//   mandate egress serve --config mandate.egress.json     the reference egress proxy (spec/egress.md): it holds the
//                                                         secrets and runs until signalled; no runtime configuration
//
// Every command reads `mandate.runtime.json` (or --config). A decision names
// the revision the person saw in `status`: if the run has moved since, it is
// refused (`stale_revision`) and nothing is recorded. What a person approves
// is what `status` showed them: the decision is bound to its digest.
//
// A decision is a record the person signs with their own key (--key), which
// the package's lock lists under their name (spec/envelope.md "Signed
// decisions"). With `decisions: { "mode": "unsigned" }` in the configuration
// a package of 0.1 to 0.3 takes `--by NAME` instead, as before 0.4.

import { execFileSync } from "node:child_process";
import { randomUUID, type KeyObject } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { callableConnectors, check, isProgram06OrLater, isProgram07OrLater, kindOf, libraryVerify, linkedProgram, loadModules, LOCK_FORMAT, packagedLock, parseStrictJson, pinnedLibraries, printProgram, toHtml, toMarkdown, type Doc, type LibrarySource, type Lock, type Modules, type Program } from "@mandate/bridge";
import { CompilerFailure } from "@mandate/bridge/mode";
import type { Adapters } from "./adapters.js";
import { Connectors } from "./connectors.js";
import { adaptersFor, anthropicClient, connect, connectorEgress, operatorAdapters, readConfig, replayAdapters, runtimeOptions, trustedKeyTexts, trustedKeysDir, type RuntimeConfig } from "./control.js";
import { credentialAdvice } from "./gateway.js";
import { deployManagedAgents, sdkApi } from "./managed-agents.js";
import { decisionId, InvalidDecision, isSignedDecision, keyFileName, memberOf, newDecisionKey, payloadOf, readDecisionKey, roleRefusal, shownPackage, signatureHolds, signDecision, signerRefusal, type DecisionKind, type PromotedMode, type SignedDecision } from "./decisions.js";
import { EvidenceSigner, keyIdOf, TrustedKeys } from "./evidence.js";
import { openDb, type Db } from "./db.js";
import { hidesFromRole, openItemLines, openItems, pass, requestLines, waitLines, waitListLine, waitsText, type PagesState, type PassResult } from "./person.js";
import { serveUntilSignalled } from "./egress/main.js";
import { limitDims, type HaltRow, type HaltScope, type Limits, type RunRow } from "./journal.js";
import { exportJournal, parseExportJson, publicKeysIn, readExport, verifyExport, type FindingCode } from "./journal-chain.js";
import { draft, drift, scan, type RepoFacts } from "./onboard.js";
import { otelEndpoint, otelExport, type OtelReport } from "./otel.js";
import { egressTransport } from "./notify.js";
import { driveLoop, MAX_INTERVAL_MS, sleep, TICK_INTERVAL_MS } from "./tick.js";
import { libraryModules, refuseRevoked } from "./package.js";
import { buildPackage, Runtime, workflowOwner } from "./runtime.js";
import { Violation } from "./signals.js";
import { shownSafe, terminalDocument, terminalText } from "./terminal.js";
import { runTests } from "./testing.js";
import { WATCH_LIMIT, type WaitItem } from "./watch.js";
import { auditDoc, roleDoc, runDoc, runView, shadowDiff, type ShadowRow } from "./views.js";
import { canonical, isObj, show, type Obj, type Value } from "./values.js";

// The terminal escaping of 0.6 output lives in terminal.ts, which the commands of 0.7 that print a run use as well.
export { shownSafe, terminalDocument, terminalText } from "./terminal.js";

interface Args {
  positional: string[];
  flags: Record<string, string | true>;
  /** `--module FILE`, repeatable: modules the program imports, such as a system model. */
  modules: string[];
  /** Repeatable `name=value` flags: `--component`, `--host`, `--repo`. */
  pairs: Record<string, Record<string, string>>;
  /** Every value a valued flag was given, in order: `--key` may be given more than once. `flags` holds the last. */
  all: Record<string, string[]>;
}

const VALUED = new Set(["--mode", "--priority", "--config", "--workflow", "--input", "--run-id", "--limit", "--revision", "--by", "--lock", "--message-id", "--format", "--name", "--target", "--agents", "--harness-tokens", "--key", "--member", "--out", "--tenant", "--reason", "--role", "--endpoint", "--run", "--libraries", "--waive", "--decline", "--interval", "--to", "--refresh"]);
const PAIRS = new Set(["--component", "--host", "--repo"]);

function parse(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const modules: string[] = [];
  const pairs: Record<string, Record<string, string>> = {};
  const all: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--module") {
      const v = argv[++i];
      if (v === undefined) throw new Usage("--module needs a file");
      modules.push(v);
    } else if (PAIRS.has(a)) {
      const v = argv[++i];
      const eq = v?.indexOf("=") ?? -1;
      if (v === undefined || eq < 1) throw new Usage(`${a} takes name=value`);
      (pairs[a] ??= {})[v.slice(0, eq)] = v.slice(eq + 1);
    } else if (!a.startsWith("--")) positional.push(a);
    else if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined) throw new Usage(`${a} needs a value`);
      flags[a] = v;
      (all[a] ??= []).push(v);
    } else flags[a] = true;
  }
  return { positional, flags, modules, pairs, all };
}

class Usage extends Error {}

/** What kept a check from being made at all, a file missing or not what it should be: exit 2, like a usage error. */
class Unchecked extends Error {}

const USAGE = `usage:
  mandate run <program> --workflow W --input <json|file> [--run-id ID] [--limit spend=20USD,tokens=2M,asks=2] [--lock FILE] [--module FILE]… [--libraries DIR] [--priority high|normal] [--mode design|read_only|live]
  mandate shadow-diff <run> <other run>
  mandate status <run> [--json]
  mandate key new [--out FILE]
  mandate approve-envelope <program> --key FILE [--member NAME] [--workflow W] [--lock FILE] [--module FILE]… [--libraries DIR] [--json]
  mandate approve <run> --revision N --key FILE [--member NAME]
  mandate decline <run> --revision N --key FILE [--member NAME]
  mandate answer <run> --revision N --key FILE [--member NAME] <text>
  mandate review <run> --revision N --key FILE [--member NAME] [--waive I,J] [--decline K]
  mandate cancel <run> [--key FILE]
  mandate reconcile <run> <operation> [--key FILE]
  mandate raise-limits <run> --revision N --key FILE [--member NAME] --limit spend=30USD
  mandate amend <run> --revision N --key FILE [--member NAME] (approve | decline)
  mandate decision <run> <digest>
  mandate verify-decision <record.json> --key <public key.pem> [--lock FILE] [--waive I,J --decline K]
  mandate journal export <run> [--out FILE]
  mandate journal key [--out FILE]
  mandate journal verify <export.json> --key <public key.pem> [--key FILE]… [--json]
  mandate replay <run>
  mandate artifact <run> <blob:sha256:…>
  mandate show <run> [--format md|html|json] [--role R | --audit]
  mandate halt (--tenant T | --all) [--reason TEXT] [--by WHO] [--json]
  mandate halt --lift (--tenant T | --all) --by WHO
  mandate halt --list [--json]
  mandate otel export --endpoint URL [--run R | --tenant T] [--follow] [--json]
  mandate tick [--follow] [--interval 10s] [--no-notify]
  mandate promote <run> --to read_only|live --key FILE [--member NAME] [--yes]
  mandate waits (--role R | --member M) [--tenant T] [--json]
  mandate watch --member M --out DIR [--follow] [--interval 10s] [--refresh SECONDS]
  mandate watch <run> --role R --jsonl
  mandate decide --key FILE [--member NAME]
  mandate denials <run>
  mandate rotate-key
  mandate test <program> [--json] [--lock FILE] [--libraries DIR]
  mandate onboard --component NAME=DIR… [--host HOST=NAME]… [--repo NAME=OWNER/REPO]… [--name MODULE]
  mandate drift --module MODEL --component NAME=DIR… [--host HOST=NAME]… [--json]
  mandate deploy <program> --target managed-agents [--lock FILE] [--module FILE]… [--libraries DIR] [--agents A,B] [--name PREFIX] [--harness-tokens N]
  mandate egress serve [--config FILE (default ./mandate.egress.json)]
  mandate connector pin <program> [--lock FILE] [--module FILE]… [--libraries DIR]
options: --config FILE (default ./mandate.runtime.json), --json, --message-id ID
--libraries DIR is the directory of libraries a lock of 0.6 pins its libraries in (default: libraries.dir of the configuration)
a decision is signed with --key; in unsigned mode (decisions.mode in the configuration) it takes --by NAME instead`;

export const CONTROL_COMMANDS = new Set(["run", "status", "approve", "decline", "answer", "cancel", "reconcile", "shadow-diff", "raise-limits", "replay", "artifact", "show", "denials", "rotate-key", "test", "onboard", "drift", "deploy", "key", "decision", "verify-decision", "approve-envelope", "amend", "journal", "egress", "halt", "otel", "connector", "review", "tick", "promote", "waits", "watch", "decide"]);

/** The commands of 0.7 that show a person what a run holds; what they print on their error path is escaped. */
const PERSON_COMMANDS = new Set(["waits", "watch", "decide"]);

/** Runs one control command; returns the exit status. */
export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s), env: NodeJS.ProcessEnv = process.env, answer: () => Promise<string> = stdinLine, standardInput?: AsyncIterable<string>): Promise<number> {
  let db: Db | undefined;
  /** The runtime the command made: what its gateways opened at the proxy is closed when the command ends. */
  let made: Runtime | undefined;
  // What the commands of 0.7 that show a run print on their error path is escaped as everything else they print is: a
  // refusal names a run id or a role the store holds, which is any text. The bytes of every other command are as they were.
  const said = (m: string): string => (PERSON_COMMANDS.has(argv[0] ?? "") ? terminalText(m) : m);
  try {
    const [cmd, ...rest] = argv;
    const a = parse(rest);
    const configFile = typeof a.flags["--config"] === "string" ? a.flags["--config"] : "mandate.runtime.json";
    if (!cmd || !CONTROL_COMMANDS.has(cmd)) throw new Usage(`unknown command ${cmd ?? ""}`);
    if (cmd === "test") return await test(a, out);
    if (cmd === "onboard") return onboard(a, out);
    if (cmd === "drift") return driftCommand(a, out);
    if (cmd === "deploy") return await deploy(a, out, env);
    if (cmd === "key") return keyNew(a, out);
    if (cmd === "verify-decision") return verifyDecision(a, out);
    if (cmd === "journal" && a.positional[0] === "verify") return journalVerify(a, out);
    if (cmd === "egress") return await egress(a, out, env);
    if (cmd === "connector") return await connectorPin(a, out, env);
    if (!existsSync(configFile)) throw new Usage(`no runtime configuration at ${configFile} (see spec/runtime.md, "Control CLI")`);
    const config = readConfig(configFile);
    db = await connect(config);
    const json = a.flags["--json"] === true;
    const runId = a.positional[0];

    if (cmd === "rotate-key") {
      const r = EvidenceSigner.rotate(config.evidence.key, trustedKeysDir(config));
      out(`evidence key rotated: ${r.old} → ${r.current}; the old public key stays trusted in ${trustedKeysDir(config)}\n`);
      return 0;
    }

    if (cmd === "run") {
      const file = a.positional[0] ?? fail("run needs a program file");
      const workflow = str(a, "--workflow");
      const { program, lock, modules, libraries, seen } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined, a.modules, undefined, librariesFrom(a, config));
      // The run's id is chosen here, so that the gateways' sessions are opened for it (and a revocation of it cuts them).
      const runId = typeof a.flags["--run-id"] === "string" ? a.flags["--run-id"] : randomUUID();
      const rt = (made = new Runtime(db, adaptersFor(config, linkedProgram(program, seen), lock, env, undefined, { tenant: "default", run: runId }), undefined, undefined, runtimeOptions(config, db)));
      const run = await rt.startRun({
        pkg: buildPackage(program, lock, modules, libraries),
        workflow,
        input: input(str(a, "--input")),
        runId,
        ...(typeof a.flags["--limit"] === "string" ? { limits: limits(a.flags["--limit"]) } : {}),
        ...(a.flags["--priority"] === "high" || a.flags["--priority"] === "normal" ? { priority: a.flags["--priority"] } : {}),
        ...(a.flags["--mode"] !== undefined ? { mode: runMode(a.flags["--mode"]) } : {}),
      });
      out(await report(rt, run, json, config));
      return 0;
    }

    if (cmd === "journal") return await journal(a, config, db, out);
    if (cmd === "halt") return await halt(a, config, db, out, (r) => (made = r));
    if (cmd === "otel") return await otel(a, db, out);
    if (cmd === "tick") return await tick(a, config, db, out, env);
    if (cmd === "waits") return await waits(a, config, db, out, (r) => (made = r));
    if (cmd === "watch") return await watch(a, config, db, out, env, (r) => (made = r));
    if (cmd === "decide") return await decide(a, config, db, out, env, standardInput, (r) => (made = r));

    if (cmd === "approve-envelope") {
      // A member of the envelope's owner role signs for the package hash its card shows (`mandate view --card`).
      const file = a.positional[0] ?? fail("approve-envelope needs a program file");
      const { program, lock, modules, libraries, seen } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined, a.modules, undefined, librariesFrom(a, config));
      const owner = envelopeOwner(program, file, typeof a.flags["--workflow"] === "string" ? a.flags["--workflow"] : undefined);
      const key = readDecisionKey(str(a, "--key"));
      const member = typeof a.flags["--member"] === "string" ? a.flags["--member"] : memberOf(lock, key.keyId);
      if (member === undefined) throw new Violation("invalid_decision", `unknown_key: the lock of ${file} lists key ${key.keyId} under no member.`);
      const pkg = buildPackage(program, lock, modules, libraries);
      const rt = (made = new Runtime(db, adaptersFor(config, linkedProgram(program, seen), lock, env), undefined, undefined, runtimeOptions(config, db)));
      const signed = signDecision(key, shownPackage(pkg.hash, owner), { kind: "envelope", member, at: new Date() });
      const decision = await rt.approveEnvelope(pkg, signed);
      out(json ? JSON.stringify({ package: pkg.hash, decision, member, role: owner, key: key.keyId, record: signed.record, signature: signed.signature }, null, 2) + "\n" : `package  ${pkg.hash}\napproved by ${member} as ${owner}\ndecision ${decision}\n`);
      return 0;
    }

    if (!runId) throw new Usage(`${cmd} needs a run id`);
    if (cmd === "promote") promotedTo(a);
    const { rt, lock } = await runtimeFor(db, config, cmd, runId, env);
    made = rt;
    // Who decides: a member, by the key they sign with (the lock says whose it is), or in unsigned mode a name.
    const key = typeof a.flags["--key"] === "string" ? readDecisionKey(a.flags["--key"]) : undefined;
    const member = key ? (typeof a.flags["--member"] === "string" ? a.flags["--member"] : memberOf(lock, key.keyId)) : undefined;
    if (key && member === undefined) throw new Violation("invalid_decision", `unknown_key: the lock of run ${runId}'s package lists key ${key.keyId} under no member.`);
    const msg = { sender: member ?? (typeof a.flags["--by"] === "string" ? a.flags["--by"] : "cli"), messageId: typeof a.flags["--message-id"] === "string" ? a.flags["--message-id"] : randomUUID() };
    /** The person's signed record of a decision on what the run shows; it names the revision they saw (--revision). */
    const sign = (about: "wait" | "run" | { reconcile: string }, kind: DecisionKind, payload?: string): Promise<SignedDecision> => signedFor(rt, runId, key!, member!, about, kind, payload, (shownRevision) => (typeof a.flags["--revision"] === "string" ? revision(a) : shownRevision));
    /** In unsigned mode, the name of who decides. */
    const by = (): string => {
      if (typeof a.flags["--by"] === "string") return a.flags["--by"];
      throw new Usage("--key FILE is required: a decision is signed (or --by NAME, in unsigned mode)");
    };
    let run: RunRow;
    switch (cmd) {
      case "status":
        run = await rt.getRun(runId);
        break;
      case "approve":
      case "decline": {
        const [rev, who] = [revision(a), key ? "" : by()];
        const w = waitOf(await rt.getRun(runId));
        if (w.kind === "amendment") throw new Violation("no_wait", `Run ${runId} is waiting for a decision on an amendment of its envelope: mandate amend ${runId} --revision ${rev} --key FILE ${cmd}`);
        if (w.kind !== "decision") throw new Violation("no_wait", `Run ${runId} is not waiting for a decision.`);
        const digest = String(w.request["subject_digest"] ?? w.request["action_digest"] ?? "");
        run = await rt.decideAction(runId, msg, key ? { signed: await sign("wait", cmd) } : { commandId: w.command, revision: rev, digest, approve: cmd === "approve", by: who });
        break;
      }
      case "answer": {
        const [rev, text] = [revision(a), a.positional.slice(1).join(" ")];
        if (!key) by();
        if (!text) throw new Usage("answer needs the text of the answer");
        const w = waitOf(await rt.getRun(runId));
        if (w.kind !== "input") throw new Violation("no_wait", `Run ${runId} is not waiting for an answer.`);
        run = await rt.submitInput(runId, msg, key ? { value: text, signed: await sign("wait", "answer", payloadOf.answer(text)) } : { commandId: w.command, revision: rev, value: text });
        break;
      }
      case "review": {
        // A review of a batch (0.6; spec/library.md "The wait and the decision"): every open item `status` listed, by
        // its index, waived or declined, in one decision signed for what the wait asks. The decision names indices
        // and nothing else.
        revision(a);
        if (!key) throw new Usage("--key FILE is required: a review is decided with a signed decision");
        const lists = { waive: itemIndices(a, "--waive"), decline: itemIndices(a, "--decline") };
        const w = waitOf(await rt.getRun(runId));
        if (w.kind !== "review") throw new Violation("no_wait", `Run ${runId} is not waiting for a review.`);
        run = await rt.decideReview(runId, msg, { ...lists, signed: await sign("wait", "review", payloadOf.review(lists)) });
        break;
      }
      case "cancel":
        run = await rt.cancelRun(runId, key ? await sign("run", "cancel") : undefined);
        break;
      case "reconcile": {
        // Asks the adapter what happened to an action whose outcome is unknown (§8.9), e.g. a change set's stopped member.
        const op = a.positional[1] ?? fail("reconcile needs the action's operation key (status shows it)");
        run = await rt.reconcileAction(runId, op, key ? await sign({ reconcile: op }, "reconcile", payloadOf.reconcile(op)) : undefined);
        break;
      }
      case "raise-limits": {
        const [rev, wanted] = [revision(a), limits(str(a, "--limit"))];
        run = await rt.raiseLimits(runId, msg, key ? { limits: wanted, signed: await sign("run", "raise_limits", payloadOf.limits(limitDims(wanted))) } : { revision: rev, limits: wanted, by: by() });
        break;
      }
      case "amend": {
        // The owner's decision on an amendment a lead asked for (spec/envelope.md "Amendments"): a signed record
        // whose subject is the hash of the package with the new envelope, as `status` showed it.
        const what = a.positional[1];
        if (what !== "approve" && what !== "decline") throw new Usage("amend takes approve or decline");
        revision(a);
        if (!key) throw new Usage("--key FILE is required: an amendment is decided with a signed decision");
        const w = waitOf(await rt.getRun(runId));
        if (w.kind !== "amendment") throw new Violation("no_wait", `Run ${runId} is not waiting for a decision on an amendment.`);
        run = await rt.decideAmendment(runId, msg, await sign("wait", what === "approve" ? "amend" : "decline"));
        break;
      }
      case "decision": {
        const id = a.positional[1] ?? fail("decision needs the decision's digest (status shows it)");
        const d = (await rt.verifyDecisions(runId)).find((x) => x.decision_id === id);
        if (!d) throw new Violation("unknown_decision", `Run ${runId} took no decision ${id}.`);
        // The record and its signature, as `mandate verify-decision` reads them.
        out(JSON.stringify({ record: d.record, signature: d.signature }, null, 2) + "\n");
        return 0;
      }
      case "show": {
        const format = typeof a.flags["--format"] === "string" ? a.flags["--format"] : "md";
        if (!["md", "html", "json"].includes(format)) throw new Usage("--format is md, html or json");
        // A role's view or the audit view (spec/boundary.md "Views by role and the audit view"); with neither, as before.
        const role = a.flags["--role"];
        if (typeof role === "string" && a.flags["--audit"] !== undefined) throw new Usage("show takes --role R or --audit, not both");
        // A run of 0.6 or later: what a model, a person or a server wrote is in the document as it was given, and Markdown is
        // printed to a terminal, HTML shown in a browser, both of which a control, format or bidirectional character
        // would move, reorder or hide text in: every such character of the document is escaped (`terminalDocument`).
        // JSON is the view's data, and stays as it is; an earlier run's document is as it was.
        const from06 = isProgram06OrLater((await rt.runProgram(runId)).source);
        const doc = (text: string): string => (from06 ? terminalDocument(text) : text);
        const print = (view: object, made: () => Doc): void => out(format === "json" ? JSON.stringify(view, null, 2) + "\n" : doc(format === "html" ? toHtml(made()) : toMarkdown(made())));
        if (typeof role === "string") {
          const { view, program, modules } = await runView(rt, runId, { role });
          print(view, () => roleDoc(view, program, modules));
        } else if (a.flags["--audit"] !== undefined) {
          const { view, program, modules } = await runView(rt, runId, { audit: true });
          print(view, () => auditDoc(view, program, modules));
        } else {
          const { view, program, modules } = await runView(rt, runId);
          print(view, () => runDoc(view, program, modules));
        }
        return 0;
      }
      case "denials":
        out(JSON.stringify(await rt.sandboxDenials(runId), null, 2) + "\n");
        return 0;
      case "artifact": {
        const ref = a.positional[1] ?? fail("artifact needs a reference, blob:sha256:…");
        const got = await rt.artifact(runId, ref);
        out(new TextDecoder().decode(got.bytes));
        return 0;
      }
      case "shadow-diff": {
        const other = a.positional[1] ?? fail("shadow-diff needs two runs");
        const d = await shadowDiff(rt, runId, other);
        out(json ? JSON.stringify(d, null, 2) + "\n" : `${d.rows.map((r) => `${r.node}\t${r.effect}\t${r.state}`).join("\n")}\ncommitted in ${d.a.run}: ${d.a.committed}, in ${d.b.run}: ${d.b.committed}\n`);
        return 0;
      }
      case "promote":
        return await promote(rt, runId, promotedTo(a), key!, member!, a.flags["--yes"] === true, out, answer);
      case "replay": {
        const r = await rt.replayRun(runId);
        out(json ? JSON.stringify(r, null, 2) + "\n" : `replay: ${r.status}${"value" in r ? `\n${show(r.value)}` : ""}${"stoppedAt" in r ? ` at ${r.stoppedAt}` : ""}${"missing" in r ? ` (missing ${r.missing})` : ""}\n`);
        return 0;
      }
      default:
        throw new Usage(`unknown command ${cmd}`);
    }
    out(await report(rt, run, json, config));
    return 0;
  } catch (e) {
    if (e instanceof Usage) {
      process.stderr.write(`mandate: ${said(e.message)}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof Unchecked) {
      process.stderr.write(`mandate: ${said(e.message)}\n`);
      return 2;
    }
    if (e instanceof Violation) {
      // A violation's message starts with its code.
      process.stderr.write(`mandate: ${said(e.message)}\n`);
      return 1;
    }
    // The compiler behind the bridge failed (its module missing, trapping, out of memory, answering what is not an
    // answer): the command did not do what it was asked, as with a usage error, and nothing was taken as checked.
    if (e instanceof CompilerFailure) {
      process.stderr.write(`mandate: ${said(e.message)}\n`);
      return 2;
    }
    throw e;
  } finally {
    await made?.adapters.egress?.close();
    await db?.close();
  }
}

/** Runs a program's tests against their handlers, on an in-process database of their own; exit 1 if any fails. */
async function test(a: Args, out: (s: string) => void): Promise<number> {
  const file = a.positional[0] ?? fail("test needs a program file");
  const { program, lock, libraries } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined, [], undefined, librariesFrom(a));
  const db = await openDb();
  try {
    const results = await runTests(program, { db, dir: dirname(file), lock, ...(libraries.length ? { libraries } : {}) });
    if (a.flags["--json"] === true) out(JSON.stringify(results, null, 2) + "\n");
    else {
      for (const r of results) out(`${r.ok ? "ok  " : "FAIL"} ${r.test}: ${r.workflow} expected ${r.expected}, ${r.ok ? "got it" : `got ${r.state}${r.detail !== undefined ? ` (${show(r.detail).slice(0, 300)})` : ""}`}\n`);
      if (!results.length) out("no tests\n");
    }
    return results.every((r) => r.ok) ? 0 : 1;
  } finally {
    await db.close();
  }
}

/** Each `--component name=dir` scanned; components are reached by their own names unless `--host` says otherwise. */
function scanned(a: Args): RepoFacts[] {
  const components = a.pairs["--component"] ?? {};
  if (!Object.keys(components).length) throw new Usage("name the working copies with --component name=dir");
  const hosts = a.pairs["--host"] ?? Object.fromEntries(Object.keys(components).map((c) => [c, c]));
  return Object.entries(components).sort(([x], [y]) => (x < y ? -1 : 1)).map(([c, dir]) => {
    if (!existsSync(dir)) throw new Usage(`no working copy at ${dir}`);
    return scan(c, resolve(dir), hosts);
  });
}

/** A draft system model from working copies, as a module on stdout: a start, checked and accepted before it is the model (doc 9 §7). */
function onboard(a: Args, out: (s: string) => void): number {
  const facts = scanned(a);
  const dirs = a.pairs["--component"]!;
  const repos: Record<string, string> = {};
  for (const f of facts) repos[f.component] = a.pairs["--repo"]?.[f.component] ?? originOf(f.root) ?? `unknown/${basename(f.root)}`;
  const roots = Object.fromEntries(facts.map((f) => [f.component, `/work/${basename(resolve(dirs[f.component]!))}`]));
  const program = draft(facts, { module: typeof a.flags["--name"] === "string" ? a.flags["--name"] : "system", repos, roots });
  const text = printProgram(program);
  out(`// A system model drafted by \`mandate onboard\` from ${facts.length} working copies. Interface names are made up and owners
// come from CODEOWNERS; consumption is inferred from calls in the code:
${facts.flatMap((f) => f.refers.map((r) => `//   ${f.component} → ${r.component}  ${r.evidence.file}:${r.evidence.line}`)).join("\n") || "//   (none found)"}
// It is not the system's model until an onboarding program has it checked and accepted (spec/system.md).

${text}`);
  return check(text, "mdt").ok ? 0 : 1;
}

/** Where a system model and the working copies disagree; exit 1 on drift, warnings alone exit 0. */
function driftCommand(a: Args, out: (s: string) => void): number {
  const file = a.modules[0] ?? a.positional[0] ?? fail("drift needs the model: --module FILE");
  const r = check(readFileSync(file, "utf8"), kindOf(file));
  if (!r.ok || !r.program) {
    for (const d of r.diagnostics) process.stderr.write(`${d.code}: ${d.message}\n`);
    return 1;
  }
  const findings = drift(r.program.defs, Object.fromEntries(scanned(a).map((f) => [f.component, f])));
  if (a.flags["--json"] === true) out(JSON.stringify(findings, null, 2) + "\n");
  else {
    for (const f of findings) {
      out(`${f.severity === "drift" ? "drift  " : "warning"} ${f.component}: ${f.detail} (${f.kind})\n`);
      for (const e of f.evidence ?? []) out(`          ${e.file}:${e.line}  ${e.text}\n`);
    }
    if (!findings.length) out("no drift\n");
  }
  return findings.some((f) => f.severity === "drift") ? 1 : 0;
}

/** `owner/repo` from a working copy's GitHub remote, if it has one. */
function originOf(dir: string): string | undefined {
  try {
    const url = execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return url.match(/github\.com[:/]([^/]+\/[^/]+?)(\.git)?$/)?.[1];
  } catch {
    return undefined;
  }
}

/**
 * The role that approves a program's envelope: the owner of the workflow `--workflow` names, or of every workflow
 * with an envelope when they have one owner. An approval is for the package, in a role; it names no workflow.
 */
function envelopeOwner(program: Program, file: string, workflow: string | undefined): string {
  const owners = new Map<string, string>();
  // 0.7: a workflow's own `owner` approves its card as an envelope's owner does (spec/attention.md "Card approval").
  let cards = false;
  for (const [name, d] of Object.entries(program.defs)) {
    const owner = workflowOwner(d);
    if (owner === undefined) continue;
    owners.set(name, owner);
    if (d.kind === "workflow" && d.envelope === undefined) cards = true;
  }
  const all = [...owners.keys()].sort();
  if (!all.length) throw new Violation("no_envelope", `${file} has no workflow with an envelope or an owner, so there is nothing to approve.`);
  if (workflow !== undefined) return owners.get(workflow) ?? fail(`no workflow ${workflow} with an envelope${cards ? " or an owner" : ""} in ${file}; it has ${all.join(", ")}`);
  const roles = [...new Set(owners.values())].sort();
  if (roles.length > 1) throw new Usage(`${file} has ${cards ? "cards" : "envelopes"} owned by ${roles.join(" and ")}; name the workflow whose ${cards ? "card" : "envelope"} you approve with --workflow: ${all.join(", ")}`);
  return roles[0]!;
}

/** The mode `mandate promote` promotes to (`--to`), and its key: a promotion is a signed decision. */
function promotedTo(a: Args): PromotedMode {
  const to = a.flags["--to"];
  if (to !== "read_only" && to !== "live") throw new Usage("--to is read_only or live: the mode the workflow is promoted to");
  if (typeof a.flags["--key"] !== "string") throw new Usage("--key FILE is required: a promotion is a signed decision");
  return to;
}

/**
 * `mandate promote <run> --to read_only|live --key FILE [--yes]` (0.7; spec/attention.md "Promotion"): the owner of a
 * workflow promotes it up the ladder on a run that succeeded. It shows the run, and for `live` the shadow diff of the
 * run against the `design` run it started under as counts of the actions that would apply, per effect, never their
 * parameters; it asks to confirm unless `--yes`; then it signs and submits. Everything it prints of a run passes
 * through `terminalText`. Exit 1 when the person does not confirm.
 */
async function promote(rt: Runtime, runId: string, to: PromotedMode, key: EvidenceSigner, member: string, yes: boolean, out: (s: string) => void, answer: () => Promise<string>): Promise<number> {
  const shown = await rt.promotionShown(runId, to);
  const lines = [
    `run       ${terminalText(runId)}`,
    `workflow  ${terminalText(shown.workflow)}`,
    `mode      ${terminalText(shown.mode)}, ${shown.state}`,
    `package   ${shown.package}`,
    `owner     ${terminalText(shown.role)}`,
    `promote   ${terminalText(shown.mode)} -> ${to}`,
    ...(shown.design !== null ? shadowCounts(await shadowDiff(rt, shown.design, runId)) : []),
    `a promotion to ${to} lets every later run of ${terminalText(shown.workflow)} of this package run ${to}`,
  ];
  out(lines.join("\n") + "\n");
  if (!yes) {
    out(`promote ${terminalText(shown.workflow)} to ${to}? [y/N] `);
    const said = (await answer()).trim().toLowerCase();
    if (said !== "y" && said !== "yes") {
      out("not promoted\n");
      return 1;
    }
  }
  const signed = signDecision(key, shown, { kind: "promote", member, payload: payloadOf.promotion(to), at: new Date() });
  const decision = await rt.promote(await rt.storedPackage(shown.package), signed);
  out(`decision  ${decision}\npromoted by ${terminalText(member)} as ${terminalText(shown.role)}\npermits   every later run of ${terminalText(shown.workflow)} of package ${shown.package} in mode ${to}\n`);
  return 0;
}

/**
 * A shadow diff as `mandate promote` shows it: per effect, how many actions the run would apply and how they compare
 * with the design run's, and how many only the design run had; the effects in order. Never a parameter, a fingerprint
 * or a command: the counts only.
 */
export function shadowCounts(d: Awaited<ReturnType<typeof shadowDiff>>): string[] {
  const by = new Map<string, Record<"would" | ShadowRow["state"], number>>();
  for (const r of d.rows) {
    const c = by.get(r.effect) ?? { would: 0, same: 0, differs: 0, only_a: 0, only_b: 0 };
    if (r.b) c.would++;
    c[r.state]++;
    by.set(r.effect, c);
  }
  const effects = [...by.keys()].sort();
  return [
    `shadow diff against design run ${terminalText(d.a.run)}:`,
    ...(effects.length
      ? effects.map((e) => {
          const c = by.get(e)!;
          return `  ${terminalText(e)}: ${c.would} would apply (${c.same} as in the design run, ${c.differs} otherwise, ${c.only_b} not in it); ${c.only_a} only in the design run`;
        })
      : ["  no action would apply"]),
  ];
}

/** One line of standard input, without its line end; empty at its end. */
async function stdinLine(): Promise<string> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  try {
    return await new Promise<string>((done) => {
      lines.once("line", done);
      lines.once("close", () => done(""));
    });
  } finally {
    lines.close();
  }
}

function fail(message: string): never {
  throw new Usage(message);
}

function runMode(v: string | true): "design" | "read_only" | "live" {
  if (v === "design" || v === "read_only" || v === "live") return v;
  throw new Usage("--mode is design, read_only or live");
}

function str(a: Args, flag: string): string {
  const v = a.flags[flag];
  if (typeof v !== "string") throw new Usage(`${flag} is required`);
  return v;
}

function revision(a: Args): number {
  const n = Number(str(a, "--revision"));
  if (!Number.isInteger(n)) throw new Usage("--revision takes the revision number `status` showed");
  return n;
}

/**
 * The item indices a flag gives, `--waive 2,5`: the map's input indices, from 0, as `status` lists them; none when
 * the flag is not given. Each is taken as written, twice included: whether they decide the review is the runtime's.
 */
function itemIndices(a: Args, flag: "--waive" | "--decline"): number[] {
  const v = a.flags[flag];
  if (v === undefined) return [];
  if (typeof v !== "string") throw new Usage(`${flag} takes item indices, e.g. ${flag} 2,5`);
  return v.split(",").map((s) => {
    const t = s.trim();
    if (!/^(0|[1-9][0-9]*)$/.test(t) || !Number.isSafeInteger(Number(t))) throw new Usage(`${flag} takes item indices, e.g. ${flag} 2,5; ${JSON.stringify(s)} is not one`);
    return Number(t);
  });
}

/** `spend=20USD,tokens=2M,steps=40,agents=30`, and (0.7) `asks=2`, the most questions the run may put to people. */
export function limits(text: string): Limits {
  const c: Limits = {};
  for (const part of text.split(",")) {
    const [k, v] = part.split("=");
    const m = v?.match(/^([0-9]+(?:\.[0-9]+)?)([kM]?)([A-Z]{3})?$/);
    if (!k || !m) throw new Usage(`cannot read the limit ${part}; write e.g. spend=20USD or tokens=2M`);
    const n = Number(m[1]) * (m[2] === "M" ? 1_000_000 : m[2] === "k" ? 1000 : 1);
    if (k === "spend") c.spend = { micros: Math.round(n * 1_000_000), currency: m[3] ?? "USD" };
    else if (k === "tokens") c.tokens = n;
    else if (k === "steps") c.steps = n;
    else if (k === "agents") c.agents = n;
    else if (k === "asks") {
      // A count of questions: a whole number, with no unit.
      if (m[3] !== undefined || !Number.isSafeInteger(n)) throw new Usage(`cannot read the limit ${part}; asks is a whole number of questions, e.g. asks=2`);
      c.asks = n;
    } else throw new Usage(`unknown limit ${k}; use spend, tokens, steps, agents or asks`);
  }
  return c;
}

function input(text: string): Obj {
  const raw = existsSync(text) ? readFileSync(text, "utf8") : text;
  const parsed = parseStrictJson(raw);
  if (!parsed.ok || !isObj(parsed.value.value as Value)) throw new Usage("--input takes a JSON object, inline or in a file");
  return parsed.value.value as Obj;
}

/** The lock file at `lockPath`, read strictly, or undefined when there is none. */
function readLock(lockPath: string): Lock | undefined {
  if (!existsSync(lockPath)) return undefined;
  const parsed = parseStrictJson(readFileSync(lockPath, "utf8"));
  if (!parsed.ok) throw new Violation("malformed_lock", `${lockPath}: ${parsed.diagnostics.map((d) => d.message).join("; ")}`);
  return parsed.value.value as unknown as Lock;
}

/** Where a command reads libraries from, and what the configuration says of them (its `libraries` member). */
interface LibrariesFrom {
  /** The directory of libraries: `--libraries`, or else `libraries.dir` of the configuration. */
  dir?: string;
  config?: RuntimeConfig["libraries"];
}

/**
 * Where `a` reads libraries from: `--libraries <dir>`, or the configuration's `libraries.dir`; and the
 * configuration's `libraries` member, whose `revoked` digests are never loaded. A command that reads no
 * configuration of its own (`test`, `deploy`) reads the one `--config` names, or `mandate.runtime.json` when it is
 * there, and only when it is asked: for a lock that pins a library.
 */
function librariesFrom(a: Args, config?: RuntimeConfig): () => LibrariesFrom {
  return () => {
    const file = typeof a.flags["--config"] === "string" ? a.flags["--config"] : "mandate.runtime.json";
    const c = config ?? (typeof a.flags["--config"] === "string" || existsSync(file) ? readConfig(file) : undefined);
    const dir = typeof a.flags["--libraries"] === "string" ? a.flags["--libraries"] : c?.libraries?.dir;
    return { ...(dir !== undefined ? { dir } : {}), ...(c?.libraries ? { config: c.libraries } : {}) };
  };
}

/** A program as a command loads it: checked, with its lock, the modules it was given, and the libraries its lock pins. */
interface Loaded {
  program: Program;
  lock: Lock;
  /** The modules `--module` gave: what the package carries as its modules. */
  modules: Modules;
  /** The libraries the lock pins, read from the directory of libraries: what the package carries as its libraries. */
  libraries: LibrarySource[];
  /** Every module the program sees: the ones it was given, and those of its libraries. */
  seen: Modules;
}

/**
 * The libraries `lock` pins, read from the directory `from` names (spec/library.md "At load"), each held to the
 * lock before the program is checked with it: a digest the configuration revokes is never loaded
 * (`library_revoked`), and a library that does not hash to the digest the lock pins is not the one that was pinned
 * (`library_digest_mismatch`). Whatever else is wrong with one is the check's to say. A lock that pins none reads
 * nothing.
 */
function pinned(lock: Lock | undefined, from: () => LibrariesFrom): { libraries: LibrarySource[]; given: LibrariesFrom } {
  const pins = lock && isObj(lock.libraries as unknown as Value) ? lock.libraries! : {};
  if (!Object.keys(pins).length) return { libraries: [], given: {} };
  const given = from();
  const held = { libraries: given.config ?? {} };
  refuseRevoked(lock!, held);
  const libraries = given.dir !== undefined ? pinnedLibraries(lock, given.dir) : [];
  const verified = libraries.map((l) => libraryVerify(l, libraries.filter((x) => x !== l)));
  refuseRevoked(lock!, held, verified.map((v) => [v.name ?? "a library of the directory", v.digest] as const));
  for (const v of verified) {
    const pin = v.name !== undefined && Object.hasOwn(pins, v.name) ? pins[v.name] : undefined;
    if (pin && v.digest !== undefined && pin.digest !== v.digest) throw new Violation("library_digest_mismatch", `Library ${v.name} in ${given.dir} hashes to ${v.digest}; the lock pins ${pin.digest}.`);
  }
  return { libraries, given };
}

/**
 * The program, checked, and its lock: --lock, or mandate.lock.json next to it (or `given`, already read). With the
 * libraries its lock pins (0.6), read from the directory `from` names: the check is given them, and the package
 * carries them.
 */
function load(file: string, lockFile: string | undefined, moduleFiles: string[] = [], given?: Lock, from: () => LibrariesFrom = () => ({})): Loaded {
  const lock = given ?? readLock(lockFile ?? join(dirname(file), "mandate.lock.json"));
  const { modules, problems } = loadModules(moduleFiles.map((f) => ({ file: f, text: readFileSync(f, "utf8"), kind: kindOf(f) })));
  if (problems.length) throw new Violation("load_verification_failed", problems.flatMap((p) => p.diagnostics.filter((d) => d.severity === "error").map((d) => `${p.file}: ${d.code} ${d.message}`)).join("\n"));
  const { libraries, given: lib } = pinned(lock, from);
  const config = lib.dir !== undefined ? { config: { dir: lib.dir, ...(lib.config?.wait_days !== undefined ? { wait_days: lib.config.wait_days } : {}), ...(lib.config?.revoked ? { revoked: lib.config.revoked } : {}) } } : {};
  const r = check(readFileSync(file, "utf8"), kindOf(file), { modules, ...(lock ? { lock } : {}), ...(libraries.length ? { libraries } : {}), ...config });
  if (!r.ok) throw new Violation("load_verification_failed", r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("\n"));
  const packaged = packagedLock(lock);
  return { program: r.program!, lock: packaged, modules, libraries, seen: libraries.length ? { ...modules, ...libraryModules({ lock: packaged, libraries }) } : modules };
}

/**
 * `mandate deploy --target managed-agents` (K45): deploys the program's
 * agents and writes the binding into the lock, which makes a new package.
 * The program is checked against the lock without its old binding, so a
 * stale binding can be replaced.
 */
async function deploy(a: Args, out: (s: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  const file = a.positional[0] ?? fail("deploy needs a program file");
  if (a.flags["--target"] !== "managed-agents") throw new Usage("deploy needs --target managed-agents, the one executor target");
  const lockPath = typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : join(dirname(file), "mandate.lock.json");
  const raw = readLock(lockPath) ?? fail(`deploy writes the binding into the lock file, and there is none at ${lockPath}`);
  const { bindings: _old, ...unbound } = raw;
  const { program, seen } = load(file, undefined, a.modules, unbound, librariesFrom(a));
  const agents = typeof a.flags["--agents"] === "string" ? a.flags["--agents"].split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const harness = typeof a.flags["--harness-tokens"] === "string" ? Number(a.flags["--harness-tokens"]) : undefined;
  if (harness !== undefined && (!Number.isInteger(harness) || harness < 0)) throw new Usage("--harness-tokens takes a whole number");
  const binding = await deployManagedAgents({
    program: linkedProgram(program, seen),
    lock: raw,
    api: sdkApi(anthropicClient(env, "deploy talks to Managed Agents")),
    ...(agents ? { agents } : {}),
    ...(typeof a.flags["--name"] === "string" ? { name: a.flags["--name"] } : {}),
    ...(harness !== undefined ? { harnessTokens: harness } : {}),
  });
  const next: Lock = { ...raw, lock: LOCK_FORMAT, bindings: { ...(raw.bindings ?? {}), "managed-agents": binding } };
  writeFileSync(lockPath, JSON.stringify(next, null, 2) + "\n");
  const lines = [
    `deployed to Managed Agents (${binding.beta}), bridge: every tool runs in the runtime's sandbox`,
    `environment ${binding.environment.id}`,
    ...Object.entries(binding.agents).map(([n, b]) => `agent ${n}: ${b.id} v${b.version} (${b.model}, effort ${b.effort}, output ceiling ${b.max_output_tokens})`),
    `profile: ${Object.entries(binding.profile).map(([g, l]) => `${g} ${l}`).join(", ")}`,
    `the binding is in ${lockPath}: the lock, and so the package hash, changed`,
  ];
  out(lines.join("\n") + "\n");
  return 0;
}

/**
 * `mandate connector pin <program>` (spec/library.md "The lock binding and schema digests"): asks each connector's
 * server for its tools, through the egress proxy the configuration names and no other way, and writes the digest of
 * every declared tool's schema into the lock entry the connector already has. The entry's credential, URL, header and
 * template are the operator's and are left as they are: a credential is a name there, and no secret is read, sent
 * or written by this command. A connector without an entry is refused (E1407); so is a declared tool the server does
 * not list (`tool_schema_mismatch`), and then nothing is written. It prints each digest that changed.
 *
 * The program is checked without the lock, whose digests are what is being written, with the libraries the lock
 * pins; and once more against the lock as it would be written, so that a lock the program does not bind its
 * connectors with (E1407, E1408) is not written.
 */
async function connectorPin(a: Args, out: (s: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  if (a.positional[0] !== "pin") throw new Usage("connector takes pin: mandate connector pin <program> [--lock FILE]");
  const file = a.positional[1] ?? fail("connector pin needs a program file");
  const lockPath = typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : join(dirname(file), "mandate.lock.json");
  const raw = readLock(lockPath) ?? fail(`connector pin writes the digests into the lock file, and there is none at ${lockPath}`);
  const configFile = typeof a.flags["--config"] === "string" ? a.flags["--config"] : "mandate.runtime.json";
  if (!existsSync(configFile)) throw new Usage(`no runtime configuration at ${configFile}: a connector's server is asked through the egress proxy it names (egress.admin)`);
  const config = readConfig(configFile);
  const { modules, problems } = loadModules(a.modules.map((f) => ({ file: f, text: readFileSync(f, "utf8"), kind: kindOf(f) })));
  if (problems.length) throw new Violation("load_verification_failed", problems.flatMap((p) => p.diagnostics.filter((d) => d.severity === "error").map((d) => `${p.file}: ${d.code} ${d.message}`)).join("\n"));
  const { libraries } = pinned(raw, librariesFrom(a, config));
  const read = { modules, ...(libraries.length ? { libraries } : {}) };
  const text = readFileSync(file, "utf8");
  const r = check(text, kindOf(file), { ...read, linked: true });
  if (!r.ok) throw new Violation("load_verification_failed", r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("\n"));
  const linked = r.linked as unknown as Program | undefined;
  if (!linked) throw new Violation("unsupported_language", `${file} is not a program of mandate/0.6: only a program of 0.6 holds connectors.`);
  const entries = { ...(isObj(raw.connectors as unknown as Value) ? raw.connectors! : {}) };
  const egress = connectorEgress(config, env);
  let pins: Record<string, Record<string, string>>;
  try {
    // Binding refuses a connector the lock has no entry for (`bad_connector`, naming E1407: the operator writes its
    // credential's name and URL first), and one whose entry names another URL than the one it declares.
    // 0.7: only the connectors the compiler says can be called are pinned, with its digests (connectors.ts).
    const callable = isProgram07OrLater(r.program as Program) ? new Set(callableConnectors(r.program, read.libraries ? { ...modules, ...libraryModules({ lock: raw, libraries: read.libraries }) } : modules).map((c) => c.id)) : undefined;
    const connectors = new Connectors({ program: linked, lock: raw, transport: egress.connectors, ...(callable ? { callable } : {}) });
    if (!connectors.any) {
      out("the program holds no connector; nothing to pin\n");
      return 0;
    }
    await egress.ready(connectors.credentials());
    pins = await connectors.pins();
  } finally {
    await egress.close();
  }
  const lines: string[] = [];
  for (const [connector, tools] of Object.entries(pins)) {
    const entry = entries[connector]!;
    const before: Record<string, string> = isObj(entry.tools as unknown as Value) ? entry.tools : {};
    for (const [tool, digest] of Object.entries(tools)) {
      const had = Object.hasOwn(before, tool) ? before[tool] : undefined;
      if (had !== digest) lines.push(`${connector}.${tool}: ${typeof had === "string" ? had : "(not pinned)"} -> ${digest}`);
    }
    for (const tool of Object.keys(before)) if (!Object.hasOwn(tools, tool)) lines.push(`${connector}.${tool}: ${String(before[tool])} -> (removed: the connector does not declare it)`);
    entries[connector] = { ...entry, tools };
  }
  const next: Lock = { ...raw, connectors: entries };
  const after = check(text, kindOf(file), { ...read, lock: next });
  const refused = after.diagnostics.filter((d) => d.severity === "error" && (d.code === "MDT-E1407" || d.code === "MDT-E1408"));
  if (refused.length) throw new Violation("load_verification_failed", `${refused.map((d) => `${d.code} ${d.message}`).join("\n")}\nNothing was written.`);
  if (!lines.length) {
    out(`every schema digest in ${lockPath} is the one its server lists; nothing changed\n`);
    return 0;
  }
  writeFileSync(lockPath, JSON.stringify(next, null, 2) + "\n");
  out(`${lines.join("\n")}\nthe digests are in ${lockPath}: the lock, and so the package hash, changed\n`);
  return 0;
}

/**
 * The commands that only read a run: none of them calls an adapter, a tool, a model, a sandbox or the proxy, or
 * moves the run forward. They are built with `operatorAdapters`, as `halt` is: the process holds no adapter that could
 * use a secret, so the environment may hold one (no `credential_in_environment`). Add a command here only after reading
 * its code path in `main`; `cancel` is not one, since it asks an adapter about an action whose outcome is unknown.
 */
const READ_ONLY_COMMANDS: ReadonlySet<string> = new Set(["status", "show", "denials", "artifact", "decision", "shadow-diff", "waits", "watch"]);

/**
 * The runtime for a run's package, and the package's lock: it says which member a key belongs to. How it is built
 * depends on the command, and on what the command may do beside a secret in the environment (spec/boundary.md "Where
 * secrets live"):
 *
 * - a read-only command (`READ_ONLY_COMMANDS`): `operatorAdapters`, no tools, no credential check;
 * - `replay`: the configuration's tool map and nothing else, every call refused (`replayAdapters`), no credential check;
 * - every other command, which can start, resume, decide or cancel (so can run an adapter): the full adapters
 *   (`adaptersFor`), and with a gateway on and its secret in `env`, `credential_in_environment`. For `cancel` the
 *   message also says what to do instead.
 */
async function runtimeFor(db: Db, config: RuntimeConfig, cmd: string, runId: string, env: NodeJS.ProcessEnv): Promise<{ rt: Runtime; lock: Lock }> {
  const [row] = await db.query<{ program: Program; lock: Lock; modules: Modules | null; libraries: LibrarySource[] | null; tenant: string }>("select p.program, p.lock, p.modules, p.libraries, r.tenant from runs r join packages p on p.package_hash = r.package_hash where r.run_id = $1", [runId]);
  if (!row) throw new Violation("unknown_run", `No run ${runId}.`);
  // The gateways' sessions, if any are opened, are for this run and its tenant.
  const scope = { tenant: row.tenant, run: runId };
  let adapters: Adapters;
  if (READ_ONLY_COMMANDS.has(cmd)) adapters = operatorAdapters(config);
  else if (cmd === "replay") adapters = replayAdapters(config, env, scope);
  else {
    try {
      adapters = adaptersFor(config, linkedProgram(row.program, row.libraries?.length ? { ...(row.modules ?? {}), ...libraryModules({ lock: row.lock, libraries: row.libraries }) } : (row.modules ?? {})), row.lock, env, undefined, scope);
    } catch (e) {
      const advice = e instanceof Violation && e.code === "credential_in_environment" ? credentialAdvice(cmd, runId, row.tenant) : undefined;
      if (advice === undefined || !(e instanceof Violation)) throw e;
      throw new Violation(e.code, `${e.message.slice(e.code.length + 2)} ${advice}`);
    }
  }
  return { rt: new Runtime(db, adapters, undefined, undefined, runtimeOptions(config, db)), lock: row.lock };
}

/**
 * `mandate key new`: a person's own ed25519 key. The private half stays in `--out` (default `mandate.key`), readable
 * by its owner only, and is never replaced. The public half is written next to it under the name the runtime's
 * `decisions.keys` directory expects, `<key id>.pem`.
 */
function keyNew(a: Args, out: (s: string) => void): number {
  if (a.positional[0] !== "new" || a.positional.length !== 1) throw new Usage("key takes new: mandate key new [--out FILE]");
  const file = resolve(typeof a.flags["--out"] === "string" ? a.flags["--out"] : "mandate.key");
  const key = newDecisionKey(file);
  const pub = join(dirname(file), keyFileName(key.keyId));
  writeFileSync(pub, key.publicKeyPem());
  out(
    [
      `key ${key.keyId}`,
      `private key: ${file} (keep it to yourself; it signs your decisions)`,
      `public key:  ${pub}`,
      key.publicKeyPem().trimEnd(),
      `to decide with it: list the key id under your name in the lock's "members", and put the public key file in the runtime's decisions.keys directory`,
    ].join("\n") + "\n",
  );
  return 0;
}

/**
 * `mandate verify-decision`: whether a decision record carries a valid signature by the key in `--key`, and with
 * `--lock` whether that lock binds the key to the record's member and role. It reads two or three files and
 * nothing else: no configuration, no database, no runtime. Exit 1 when the decision does not hold.
 */
function verifyDecision(a: Args, out: (s: string) => void): number {
  const file = a.positional[0] ?? fail("verify-decision needs a decision record file");
  const keyFile = str(a, "--key");
  const parsed = parseStrictJson(readFileSync(file, "utf8"));
  const signed: unknown = parsed.ok ? parsed.value.value : undefined;
  let keys: TrustedKeys;
  try {
    keys = new TrustedKeys([readFileSync(keyFile, "utf8")]);
  } catch (e) {
    throw new Violation("bad_decision_key", `${keyFile} is not an ed25519 public key: ${(e as Error).message}`);
  }
  const keyId = keys.ids()[0]!;
  const lock = typeof a.flags["--lock"] === "string" ? (readLock(a.flags["--lock"]) ?? fail(`no lock file at ${a.flags["--lock"]}`)) : undefined;
  // A review's decision (0.6) carries the digest of the items it waived and declined: given them, it is checked too.
  const lists = a.flags["--waive"] !== undefined || a.flags["--decline"] !== undefined ? { waive: itemIndices(a, "--waive"), decline: itemIndices(a, "--decline") } : undefined;
  const problem = !isSignedDecision(signed)
    ? `${file} is not a signed decision record ({ "record": …, "signature": "ed25519:…" })`
    : signed.record.key !== keyId
      ? `the record names key ${signed.record.key}; ${keyFile} holds ${keyId}`
      : !signatureHolds(signed, keys)
        ? `the signature does not verify under key ${keyId}: the record is not what was signed`
        : lists && signed.record.kind !== "review"
          ? `the record is a decision of kind ${signed.record.kind}, which decides no items (--waive, --decline are for a review's)`
          : lists && signed.record.payload !== payloadOf.review(lists)
            ? `the review's decision did not waive ${lists.waive.join(",") || "nothing"} and decline ${lists.decline.join(",") || "nothing"}: its payload is the digest of other lists`
            : lock
              ? (signerRefusal(signed, keys, lock) ?? roleRefusal(signed.record, lock, signed.record.role))?.message
              : undefined;
  if (problem || !isSignedDecision(signed)) {
    out(`invalid: ${problem}\n`);
    return 1;
  }
  const r = signed.record;
  out(
    [
      `valid: decision ${decisionId(r)}`,
      `  ${r.kind} by ${r.member}${r.role !== undefined ? ` as ${r.role}` : ""}, signed ${r.at} with key ${r.key}`,
      `  package ${r.package}`,
      ...(r.run !== undefined ? [`  run ${r.run}${r.revision !== undefined ? ` at revision ${r.revision}` : ""}${r.command !== undefined ? `, ${r.command}` : ""}`] : []),
      `  subject ${r.subject}${r.payload !== undefined ? `, payload ${r.payload}` : ""}`,
      ...(r.kind === "review" ? [lists ? `  it waived ${lists.waive.join(",") || "nothing"} and declined ${lists.decline.join(",") || "nothing"}` : "  a review's decision: its payload is the digest of the items it waived and declined (--waive, --decline check them)"] : []),
      lock ? `  the lock binds the key to ${r.member}${r.role !== undefined ? `, who holds ${r.role}` : ""}` : "  the signature holds; whether the key is this member's is what the package's lock says (--lock)",
    ].join("\n") + "\n",
  );
  return 0;
}

/**
 * `mandate journal export <run>` and `mandate journal key` (spec/journal.md). The export is read from the database
 * as it is, and checked by nobody here. The keys are the evidence key's public half and those of the keys rotated
 * out or named in the configuration: the keys an anchor of this runtime may be signed with.
 */
async function journal(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void): Promise<number> {
  const [what, runId, ...rest] = a.positional;
  const file = typeof a.flags["--out"] === "string" ? resolve(a.flags["--out"]) : undefined;
  // Neither command may write over the evidence key: its private half is in that file and nowhere else.
  const same = (x: string, y: string): boolean => (process.platform === "win32" ? x.toLowerCase() === y.toLowerCase() : x === y);
  if (file && same(file, resolve(config.evidence.key))) throw new Usage(`--out ${file} is the evidence key; write the ${what === "key" ? "public keys" : "export"} somewhere else`);
  if (what === "export") {
    if (!runId || rest.length) throw new Usage("journal export takes one run: mandate journal export <run> [--out FILE]");
    const x = await exportJournal(db, runId);
    const text = JSON.stringify(x, null, 2) + "\n";
    // The runtime writes any journal; a verifier reads one only within the limits every verifier holds to.
    const read = parseExportJson(text);
    if (!read.ok && read.over) process.stderr.write(`mandate: the export is beyond what a verifier reads (${read.problem}): mandate journal verify will report it unreadable\n`);
    if (!file) out(text);
    else {
      writeFileSync(file, text);
      out(`run ${runId}: ${x.events.length} events, ${x.anchors.length} anchors, written to ${file}\n`);
    }
    return 0;
  }
  if (what === "key") {
    if (runId !== undefined) throw new Usage("journal key takes no run: mandate journal key [--out FILE]");
    // The key is read, never made: a key made here would have signed nothing.
    if (!existsSync(config.evidence.key)) throw new Violation("no_evidence_key", `No evidence key at ${config.evidence.key}: this runtime has signed nothing yet, so there is no key to verify against.`);
    const current = EvidenceSigner.fromPem(readFileSync(config.evidence.key, "utf8"));
    // The keys the runtime trusts, as the runtime reads them (runtimeOptions): its own first, then the others by key id.
    const trusted = new TrustedKeys([current.publicKey, ...trustedKeyTexts(config)]);
    const keys = new Map([[current.keyId, current.publicKey], ...trusted.ids().filter((id) => id !== current.keyId).map((id) => [id, trusted.publicKeys().find((k) => keyIdOf(k) === id)!] as const)]);
    const text = [...keys.values()].map((k) => k.export({ type: "spki", format: "pem" }) as string).join("");
    if (!file) out(text);
    else {
      try {
        writeFileSync(file, text, { flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new Usage(`${file} exists; journal key writes a new file`);
        throw e;
      }
      out(`${keys.size === 1 ? "1 key" : `${keys.size} keys`} written to ${file}: ${[...keys.keys()].join(", ")} (${current.keyId} signs now)\n`);
    }
    return 0;
  }
  throw new Usage("journal takes export, key or verify");
}

/**
 * `mandate otel export` (spec/boundary.md "The OpenTelemetry projection"): the journal of one run, of a tenant's runs
 * or of every run, as spans without content, posted to a collector from each run's cursor. It takes no lease and
 * writes no event; its one write is the cursor. Exit 1 when a post failed. With `--follow` it keeps going until
 * SIGINT or SIGTERM, which stop it cleanly, and exits 1 only when it stopped while the collector was failing.
 */
async function otel(a: Args, db: Db, out: (s: string) => void): Promise<number> {
  if (a.positional[0] !== "export" || a.positional.length > 1) throw new Usage("otel takes export: mandate otel export --endpoint URL [--run R | --tenant T] [--follow]");
  const run = a.flags["--run"];
  const tenant = a.flags["--tenant"];
  if (run !== undefined && tenant !== undefined) throw new Usage("otel export takes one of --run and --tenant");
  let endpoint: string;
  try {
    endpoint = otelEndpoint(str(a, "--endpoint"));
  } catch (e) {
    if (e instanceof Violation && e.code === "invalid_endpoint") throw new Usage(e.message);
    throw e;
  }
  const json = a.flags["--json"] === true;
  const follow = a.flags["--follow"] === true;
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const report: OtelReport = await otelExport(db, {
      endpoint,
      ...(typeof run === "string" ? { scope: { run } } : typeof tenant === "string" ? { scope: { tenant } } : {}),
      follow,
      signal: stop.signal,
      onPost: (p) => {
        if (!json) out(`run ${p.run}: events ${p.from} to ${p.to} sent in ${p.spans === 1 ? "1 span" : `${p.spans} spans`}\n`);
      },
      onFailure: (m) => process.stderr.write(`mandate: ${m}\n`),
    });
    if (json) out(JSON.stringify(report, null, 2) + "\n");
    else {
      if (!report.runs.some((r) => r.events > 0)) out("nothing to export\n");
      if (report.rejected > 0) process.stderr.write(`mandate: the collector rejected ${report.rejected} spans; they are not sent again\n`);
    }
    return report.failed !== undefined ? 1 : 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

/** `--interval` of `tick` and of `watch --follow`: how long a pass waits for the next, a duration (default 10 s), only with `--follow`. */
function intervalOf(a: Args, follow: boolean): number {
  const given = a.flags["--interval"];
  if (given !== undefined && !follow) throw new Usage("--interval is how long --follow waits between two passes");
  const m = typeof given === "string" ? /^([1-9][0-9]{0,8})(ms|s|m|h)?$/.exec(given) : null;
  if (typeof given === "string" && !m) throw new Usage("--interval is a duration: 500ms, 10s, 2m or 1h (a number alone is seconds)");
  const intervalMs = m ? Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[(m[2] ?? "s") as "ms" | "s" | "m" | "h"] : TICK_INTERVAL_MS;
  // Node cuts a longer timer to 1 ms: the loop would pass without pause.
  if (intervalMs > MAX_INTERVAL_MS) throw new Usage(`--interval is at most ${MAX_INTERVAL_MS} ms (about 24 days)`);
  return intervalMs;
}

/**
 * `mandate tick` (spec/attention.md "The driver loop"): one pass, or with `--follow` one pass every `--interval`
 * (10 s unless given) until SIGINT or SIGTERM. Each run that waits is ticked by a runtime built for its own package,
 * as every command that may move a run builds one; then, unless `--no-notify`, the notifications of 0.7 runs go out
 * through the channels of the configuration's `notifications`, one attempt per notification per pass. It prints each
 * run it moved, and what it gave up; everything of a run it prints passes through `terminalText`. Exit 1 when a run's
 * tick failed or a channel's way out was not there in the (last) pass. With `--follow`, a pass that fails as a whole is
 * reported and the next one comes; it ends saying how many passes it made.
 */
async function tick(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  if (a.positional.length) throw new Usage("tick takes no run: mandate tick [--follow] [--interval 10s] [--no-notify]");
  const follow = a.flags["--follow"] === true;
  const intervalMs = intervalOf(a, follow);
  const notifications = a.flags["--no-notify"] === true ? undefined : config.notifications;
  const err = (s: string): void => void process.stderr.write(`mandate: ${s}\n`);
  const message = (e: unknown): string => terminalText(e instanceof Error ? e.message : String(e));
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const { last, passes } = await driveLoop(db, {
      // A runtime for the run's package, as every command that may move a run builds one, closed once the run is
      // ticked: its gateways' sessions and its checker's worker with it.
      runtimeFor: async (runId) => {
        const { rt } = await runtimeFor(db, config, "tick", runId, env);
        return {
          rt,
          close: async () => {
            await rt.adapters.egress?.close();
            await rt.checker.close?.();
          },
        };
      },
      ...(notifications
        ? {
            notify: {
              config: notifications,
              ...(config.egress?.admin ? { transport: egressTransport({ admin: config.egress.admin }) } : {}),
              onDead: (d) => err(`notification ${d.id} (run ${terminalText(d.run)}, event ${d.seq}) on channel ${d.channel} given up after ${d.attempts === 1 ? "1 attempt" : `${d.attempts} attempts`}: ${terminalText(d.reason)}`),
              onFailure: (channel, message) => err(`channel ${channel}: ${terminalText(message)}; its notifications wait for the next pass`),
            },
          }
        : {}),
      follow,
      intervalMs,
      signal: stop.signal,
      onTicked: (r) => out(`run ${terminalText(r.run)}: ${r.before.state} -> ${r.after.state}, revision ${r.before.revision} -> ${r.after.revision}\n`),
      onError: (run, e) => err(`run ${terminalText(run)}: ${message(e)}`),
      onNotifyError: (e) => err(`the notification pass failed: ${message(e)}`),
      onPassError: (e) => err(`a pass failed: ${message(e)}; the next one comes in ${intervalMs} ms`),
      onPass: (r) => {
        if (follow) return;
        const n = r.notify;
        out(`tick: ${r.waiting === 1 ? "1 run waiting" : `${r.waiting} runs waiting`}, ${r.moved} moved${r.failed ? `, ${r.failed} failed` : ""}; notifications: ${n ? `${n.sent} sent, ${n.dead} given up, ${n.pending} to try again` : notifications ? "failed" : "off"}\n`);
      },
    });
    if (follow) out(`tick: stopped after ${passes === 1 ? "1 pass" : `${passes} passes`}\n`);
    return !last || last.failed || last.notify?.failures.length ? 1 : 0;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

/**
 * `mandate halt` (spec/boundary.md "Violations and halt"): the operator's hard stop of a tenant or of every tenant,
 * its lift, and the list of halts. Halting reads no secret and no package, and refuses none that the environment holds.
 * With an egress proxy in the configuration, it revokes the proxy's sessions of the scope; `made` is told of the
 * runtime, so that its admin connection is closed when the command ends. A lift and a list never reach the proxy. Exit
 * 1 when the halt is in force but what comes after it failed (revoking, asking an open action to stop): the runs have
 * ended all the same.
 */
async function halt(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void, made: (rt: Runtime) => void): Promise<number> {
  if (a.positional.length) throw new Usage("halt takes no run: mandate halt (--tenant T | --all) [--reason TEXT]");
  const json = a.flags["--json"] === true;
  const rt = new Runtime(db, operatorAdapters(config), undefined, undefined, runtimeOptions(config, db));
  made(rt);
  const where = (h: HaltRow): string => (h.tenant === null ? "every tenant" : `tenant ${h.tenant}`);
  if (a.flags["--list"] === true) {
    if (a.flags["--lift"] !== undefined || a.flags["--tenant"] !== undefined || a.flags["--all"] !== undefined) throw new Usage("halt --list takes no scope: mandate halt --list [--json]");
    const all = await rt.halts();
    if (json) out(JSON.stringify(all, null, 2) + "\n");
    else {
      for (const h of all) {
        const by = h.halted_by !== null ? ` by ${h.halted_by}` : "";
        const state = h.lifted_at === null ? "in force" : `lifted by ${h.lifted_by} at ${new Date(h.lifted_at).toISOString()}`;
        out(`${h.halt_id}  ${where(h)}  ${state}; halted${by} at ${new Date(h.halted_at).toISOString()}${h.reason !== null ? `: ${h.reason}` : ""}\n`);
      }
      if (!all.length) out("no halts\n");
    }
    return 0;
  }
  const tenant = a.flags["--tenant"];
  const everyone = a.flags["--all"] === true;
  if ((typeof tenant === "string") === everyone) throw new Usage("halt needs its scope, one of --tenant T and --all");
  const scope: HaltScope = typeof tenant === "string" ? { tenant } : { all: true };
  if (a.flags["--lift"] === true) {
    if (a.flags["--reason"] !== undefined) throw new Usage("a lift takes no --reason; it is recorded with --by");
    const lifted = await rt.liftHalt(scope, str(a, "--by"));
    const still = "tenant" in scope ? await rt.journal.openHalt(scope.tenant) : undefined;
    if (json) out(JSON.stringify({ lifted, ...(still ? { still_halted_by: still } : {}) }, null, 2) + "\n");
    else {
      for (const h of lifted) out(`lifted ${h.halt_id} (${where(h)}), by ${h.lifted_by}\n`);
      if (still && "tenant" in scope) out(`tenant ${scope.tenant} is still halted by ${still.halt_id} (${where(still)})\n`);
      out("no run comes back: what the halt ended stays ended\n");
    }
    return 0;
  }
  const r = await rt.halt(scope, { ...(typeof a.flags["--reason"] === "string" ? { reason: a.flags["--reason"] } : {}), ...(typeof a.flags["--by"] === "string" ? { by: a.flags["--by"] } : {}) });
  if (json) out(JSON.stringify(r, null, 2) + "\n");
  else {
    const lines = [`halted ${where(r.halt)}: ${r.halt.halt_id}${r.halt.reason !== null ? ` (${r.halt.reason})` : ""}`, `${r.ended.length === 1 ? "1 run" : `${r.ended.length} runs`} ended`];
    for (const e of r.ended) lines.push(`  ${e.run}  ${e.tenant}  ${e.state}${e.state === "attention_required" ? ": an action is open; mandate status shows it, mandate reconcile resolves it" : ""}`);
    lines.push(`starts and resumes in ${where(r.halt)} are refused until mandate halt --lift ${"all" in scope ? "--all" : `--tenant ${scope.tenant}`} --by <you>`);
    lines.push(`revoke: ${r.revoke === "revoked" ? "done" : r.revoke === "none" ? "nothing configured holds sessions to revoke" : `FAILED: ${r.revoke.failed}`}`);
    for (const p of r.problems) lines.push(`problem: ${p}`);
    out(lines.join("\n") + "\n");
  }
  const failed = r.revoke !== "revoked" && r.revoke !== "none";
  if (failed || r.problems.length) {
    process.stderr.write(`mandate: the halt is in force and its runs have ended, but ${failed ? "revoking failed" : "not everything after it succeeded"}; see above\n`);
    return 1;
  }
  return 0;
}

/** What each finding means, as `journal verify` prints it. */
const FINDINGS: Record<FindingCode, string> = {
  malformed_export: "the export is not a journal export",
  export_over_limit: "the export is larger or deeper than a verifier reads",
  seq_gap: "the events are not numbered 1, 2, 3, … from here: one was removed or moved",
  hash_missing: "the event of a chained run has no hash",
  chain_broken: "the event's hash is not the hash of its contents and of the hash before it",
  manifest_mismatch: "the manifest is not the one the first event names",
  package_mismatch: "the package is not the one the first event names",
  anchor_unknown_key: "the anchor is signed by a key not given",
  anchor_signature_invalid: "the anchor's signature does not verify",
  anchor_beyond_end: "the anchor names an event past the last one: the tail was cut",
  anchor_mismatch: "the anchor's hash or time is not the event's",
  anchor_missing: "the state event has no anchor",
  unanchored_tail: "no signature covers the events from here on",
};

/**
 * `mandate journal verify`: whether a journal export holds under the public keys given (spec/journal.md
 * "Verification"). It reads the export and the key files and nothing else: no configuration, no database, no
 * runtime. Exit 0 when verified; 1 when broken or unchained, checked and not verified; 2 when nothing could be
 * checked: a usage error, an export or key file missing or not what it should be, or an unreadable export.
 */
function journalVerify(a: Args, out: (s: string) => void): number {
  const [, file, ...rest] = a.positional;
  if (!file || rest.length) throw new Usage("journal verify takes one export file: mandate journal verify <export.json> --key <public key.pem>");
  const keyFiles = a.all["--key"] ?? [];
  if (!keyFiles.length) throw new Usage("journal verify needs the public keys the anchors are verified against: --key <public key.pem> (mandate journal key writes them)");
  const read = (f: string, what: string): Buffer => {
    let st;
    try {
      st = statSync(f);
    } catch {
      throw new Unchecked(`no ${what} at ${f}`);
    }
    if (!st.isFile()) throw new Unchecked(`${f} is not a file; the ${what} is`);
    try {
      return readFileSync(f);
    } catch (e) {
      throw new Unchecked(`cannot read the ${what} ${f}: ${(e as Error).message}`);
    }
  };
  const keys = keyFiles.flatMap((k) => {
    let found: KeyObject[];
    try {
      found = publicKeysIn(read(k, "key file").toString("utf8"));
    } catch (e) {
      if (e instanceof Unchecked) throw e;
      throw new Unchecked(`${k} is not an ed25519 public key: ${(e as Error).message}`);
    }
    if (!found.length) throw new Unchecked(`${k} holds no public key (PEM)`);
    return found;
  });
  const bytes = read(file, "export");
  const r = verifyExport(bytes, keys);
  if (a.flags["--json"] === true) out(JSON.stringify(r, null, 2) + "\n");
  else {
    const why = r.status === "unreadable" ? readExport(bytes) : undefined;
    const lines = [`${r.status}: ${r.run !== null ? `run ${r.run}, ${r.events} events` : file}`];
    if (r.status === "unreadable") lines.push("  the export could not be read, so nothing is said about the journal");
    if (r.status === "unchained") lines.push("  the run began before its journal was chained: no event has a hash and nothing is anchored, so nothing can be verified");
    for (const f of r.findings) lines.push(`  ${f.code}${f.seq !== undefined ? ` at seq ${f.seq}` : ""}: ${FINDINGS[f.code]}${why && !why.ok ? ` (${why.problem})` : ""}`);
    // How far the signatures reach is what a verified journal says; in a broken one the events are not what was signed.
    if (r.status === "verified" && r.anchored_through !== null) lines.push(`  signed through seq ${r.anchored_through} by ${r.signed_by.join(", ")}; ${r.unanchored === 1 ? "1 event" : `${r.unanchored} events`} after it covered by no signature`);
    out(lines.join("\n") + "\n");
  }
  return r.status === "verified" ? 0 : r.status === "unreadable" ? 2 : 1;
}

/**
 * `mandate egress serve`: the reference egress proxy, started by the operator in an environment that holds the
 * secrets its configuration names. It reads no runtime configuration and opens no database. It prints one line when
 * it is ready and serves until SIGINT or SIGTERM; then it closes its sessions and removes its socket.
 */
async function egress(a: Args, out: (s: string) => void, env: NodeJS.ProcessEnv): Promise<number> {
  if (a.positional[0] !== "serve" || a.positional.length !== 1) throw new Usage("egress takes serve: mandate egress serve --config mandate.egress.json");
  const file = typeof a.flags["--config"] === "string" ? a.flags["--config"] : "mandate.egress.json";
  if (!existsSync(file)) throw new Usage(`no egress configuration at ${file} (see spec/egress.md, "Configuration")`);
  await serveUntilSignalled({ config: file, env }, out);
  return 0;
}

function waitOf(run: RunRow): { kind: string; command: string; request: Obj } {
  const w = run.waiting;
  if (run.state !== "waiting" || !isObj(w)) throw new Violation("no_wait", `Run ${run.run_id} is ${run.state}, not waiting.`);
  const kind = w["kind"] === "budget_exceeded" ? "input" : String(w["kind"]);
  return { kind, command: String(w["command"]), request: isObj(w["request"] ?? null) ? (w["request"] as Obj) : {} };
}

/**
 * What a review's wait asks (0.6), as `status` shows it: the role asked, its deadline and who it escalates to, each
 * open item by its index with what it failed and who may waive that, and its value, which a model wrote; then the
 * command that decides it.
 */
function reviewLines(run: RunRow, req: Obj, as: string): string[] {
  const q = isObj(req["question"] ?? null) ? (req["question"] as Obj) : {};
  const items = (Array.isArray(q["items"]) ? q["items"] : []).filter(isObj) as Obj[];
  const until = typeof req["deadline"] === "number" ? new Date(req["deadline"]).toISOString() : "?";
  const then = typeof req["escalate_to"] === "string" && req["escalated"] === undefined ? `; then ${req["escalate_to"]} is asked` : "; then every open item is declined";
  const lines = [`waiting for: ${String(req["role"] ?? "a person")} to review ${items.length} item${items.length === 1 ? "" : "s"} that failed ${String(q["contract"] ?? "its contract")} only where a person may waive it (deadline ${until}${then})`];
  for (const i of items) {
    const unmet = (Array.isArray(i["unmet"]) ? i["unmet"] : []).filter(isObj) as Obj[];
    lines.push(`  item ${String(i["index"])}: unmet ${unmet.map((u) => `${String(u["criterion"])} ("${terminalText(String(u["description"] ?? ""))}"; waivable by ${(Array.isArray(u["waive"]) ? u["waive"] : []).join(", ")})`).join(", ")}`);
    lines.push(`    value (model output): ${terminalText(canonical((i["value"] ?? null) as Value))}`);
  }
  const declined = Array.isArray(q["declined"]) ? q["declined"].filter(isObj).map((d) => String((d as Obj)["index"])) : [];
  if (declined.length) lines.push(`  declined without asking (they failed what no one may waive): ${declined.join(", ")}`);
  const failed = Array.isArray(q["failed"]) ? q["failed"].map(String) : [];
  if (failed.length) lines.push(`  failed (their work did not end): ${failed.join(", ")}`);
  const all = items.map((i) => String(i["index"])).join(",");
  lines.push(`  decide: mandate review ${run.run_id} --revision ${run.revision} ${as} --waive <indices> --decline <indices> (every open item once: ${all})`);
  return lines;
}

/** What a person needs to see to decide: the run, what it waits for, the budget, the evidence and the actions. */
async function report(rt: Runtime, run: RunRow, json: boolean, config: RuntimeConfig): Promise<string> {
  const budget = await rt.budgetReport(run.run_id);
  const evidence = await rt.evidence(run.run_id);
  const signed = new Map((await rt.verifyEvidence(run.run_id)).map((e) => [e.evidence_id, e.valid]));
  const actions = await rt.journal.actions(run.run_id);
  const decisions = await rt.verifyDecisions(run.run_id);
  // How this configuration takes a decision: signed with a key, or by name.
  const as = config.decisions.mode === "unsigned" ? "--by <you>" : "--key <your key file>";
  if (json) return JSON.stringify({ run, budget, evidence: evidence.map((e) => ({ ...e, signature_valid: signed.get(e.evidence_id) ?? false })), actions, ...(decisions.length ? { decisions } : {}) }, null, 2) + "\n";
  // In a run of 0.6 or later every value a model, a person or a server wrote is shown with its texts quoted, and with every
  // code point a terminal does not print as itself escaped (`shownSafe`); an earlier run's lines are as they were.
  const from06 = isProgram06OrLater((await rt.runProgram(run.run_id)).source);
  const shown = (v: Value): string => (from06 ? shownSafe(v) : show(v));
  const lines = [`run ${run.run_id}  ${run.workflow}  ${run.state}  revision ${run.revision}`];
  if (run.state === "waiting" && isObj(run.waiting)) {
    const w = run.waiting;
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    if (w["kind"] === "decision" && "criterion" in req) {
      lines.push(`waiting for: ${req["role"] ?? "a person"} to approve ${req["contract"]}.${req["criterion"]}`);
      lines.push(`  subject digest ${req["subject_digest"]}${typeof req["deadline"] === "number" ? `, deadline ${new Date(req["deadline"]).toISOString()}` : ""}`);
      lines.push(...subjectLines(req["subject"] ?? null, shown));
      if (config.verifier) lines.push(`  the change in ${config.verifier.workdir}: git -C ${config.verifier.workdir} diff ${config.verifier.base}`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} ${as}`, `  decline: mandate decline ${run.run_id} --revision ${run.revision} ${as}`);
    } else if (w["kind"] === "amendment") {
      // What the owner signs for is the new package's hash. The reason is the lead's own text: a model wrote it.
      lines.push(`waiting for: ${req["role"] ?? "the owner"} to decide an amendment of ${req["workflow"]}'s envelope, asked by ${req["lead"]}`);
      lines.push(`  package ${req["from"]} → ${req["package"]}${typeof req["deadline"] === "number" ? `, deadline ${new Date(req["deadline"]).toISOString()}` : ""}`);
      const changes = Array.isArray(req["changes"]) ? req["changes"] : [];
      for (const c of changes) if (isObj(c)) lines.push(`  ${String(c["text"])}`);
      if (!changes.length) lines.push("  the envelope's amounts and capabilities are as they were");
      const reason = JSON.stringify(String(req["reason"] ?? ""));
      lines.push(`  the lead's reason (model output): ${from06 ? terminalText(reason) : reason}`);
      lines.push(`  approve: mandate amend ${run.run_id} --revision ${run.revision} ${as} approve`, `  decline: mandate amend ${run.run_id} --revision ${run.revision} ${as} decline`);
    } else if (w["kind"] === "timer") {
      lines.push(`waiting for: a timer until ${typeof req["until"] === "number" ? new Date(req["until"]).toISOString() : "?"} (${String(req["reason"] ?? "")}); the scheduler resumes the run then`);
    } else if (w["kind"] === "review") {
      lines.push(...reviewLines(run, req, as));
    } else if (w["kind"] === "decision") {
      lines.push(`waiting for: approval of action ${req["effect"] ?? ""} (digest ${req["action_digest"]})`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} ${as}`);
    } else {
      const q = req["question"] ?? req["escalation"] ?? (w["kind"] === "budget_exceeded" ? "Budget exceeded." : null);
      lines.push(`waiting for: an answer${q !== null ? `: ${shown(q as Value)}` : ""}`);
      if (w["kind"] === "budget_exceeded") lines.push(`  raise:  mandate raise-limits ${run.run_id} --revision ${run.revision} ${as} --limit spend=<amount>USD`);
      lines.push(`  answer: mandate answer ${run.run_id} --revision ${run.revision} ${as} <text>`);
    }
  }
  if (run.state === "attention_required") lines.push(`attention: ${shown(run.attention ?? null)}`);
  if (run.state === "failed") lines.push(`error: ${shown(run.error ?? null)}`);
  if (run.state === "succeeded") lines.push(`result: ${shown(run.result ?? null)}`);
  for (const d of budget.dimensions) {
    const money = d.dimension.startsWith("spend:");
    const f = (n: number) => (money ? `${(n / 1_000_000).toFixed(4)} ${d.dimension.slice(6)}` : String(n));
    lines.push(`budget ${d.dimension}: limit ${f(d.limit)}, settled ${f(d.settled)}, reserved ${f(d.reserved)}, available ${f(d.available)}`);
  }
  // A waiver (0.6) is not a check that passed: it is shown as what it is, beside the failed check it waives.
  for (const e of evidence) lines.push(`evidence ${e.contract}.${e.criterion}: ${e.method === "waiver" ? "waived" : e.passed ? "met" : "not met"} (${e.method}; ${signed.get(e.evidence_id) ? "signed" : "SIGNATURE INVALID"})`);
  for (const d of decisions) lines.push(`decision ${d.record.kind} by ${d.record.member}${d.record.role !== undefined ? ` as ${d.record.role}` : ""}: ${d.valid ? "signed" : "SIGNATURE INVALID"} (${d.decision_id})`);
  for (const x of actions) lines.push(`action ${x.effect}: ${x.state}${x.receipt ? ` ${shown(x.receipt)}` : ""}`);
  return lines.join("\n") + "\n";
}

function subjectLines(subject: Value, shown: (v: Value) => string = show): string[] {
  const parts = Array.isArray(subject) ? subject : [subject];
  const out: string[] = [];
  for (const p of parts) {
    if (!isObj(p)) continue;
    for (const k of ["issue", "patch", "tests", "review"]) {
      const v = p[k];
      if (v !== undefined) out.push(`  ${k}: ${shown(v).slice(0, 600)}`);
    }
  }
  return out;
}

/** The runtime of a command that only reads: built without an adapter that could use a secret, so the environment may hold one. */
function readerRuntime(config: RuntimeConfig, db: Db): Runtime {
  return new Runtime(db, operatorAdapters(config), undefined, undefined, runtimeOptions(config, db));
}

/**
 * A person's signed record of a decision on what the run shows now (`Runtime.shown`), naming the revision they decided
 * on: `seen` is given the run's revision and says which one (the one `--revision` names, or the one a listing showed).
 * The one place a command signs a decision about a wait or a run, for `approve`, `answer`, `review`, `amend`, `cancel`
 * and the others, and for `decide`.
 */
async function signedFor(rt: Runtime, runId: string, key: EvidenceSigner, member: string, about: "wait" | "run" | { reconcile: string }, kind: DecisionKind, payload: string | undefined, seen: (shownRevision: number) => number): Promise<SignedDecision> {
  const shown = await rt.shown(runId, about);
  return signDecision(key, { ...shown, revision: seen(shown.revision) }, { kind, member, ...(payload !== undefined ? { payload } : {}), at: new Date() });
}

/** JSON as a terminal may be shown it: the same value, with every code point a terminal does not print as itself written `\uXXXX` inside its texts. */
const jsonText = (v: unknown, indent?: number): string => terminalDocument(JSON.stringify(v, null, indent));

/**
 * `mandate waits (--role R | --member M) [--tenant T] [--json]` (spec/attention.md "The command line"): the open
 * decisions of a role or a member across all runs, as `Runtime.listWaits` gives them, each value masked by the cap of
 * the role it is listed to and labelled. Read-only. A role or member no package binds lists nothing, and is no error.
 * `--json` prints the list as JSON; its texts are escaped as every other output's are, and are the same values.
 */
async function waits(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void, made: (rt: Runtime) => void): Promise<number> {
  if (a.positional.length) throw new Usage("waits takes no run: mandate waits (--role R | --member M) [--tenant T] [--json]");
  const role = a.flags["--role"];
  const member = a.flags["--member"];
  if ((typeof role === "string") === (typeof member === "string")) throw new Usage("waits takes one of --role R and --member M: mandate waits (--role R | --member M) [--tenant T] [--json]");
  const tenant = a.flags["--tenant"];
  const who = typeof role === "string" ? { role } : { member: member as string };
  const rt = readerRuntime(config, db);
  made(rt);
  const items = await rt.listWaits(who, typeof tenant === "string" ? { tenant } : {});
  out(a.flags["--json"] === true ? jsonText(items, 2) + "\n" : waitsText(who, items));
  return 0;
}

/**
 * `mandate watch` (spec/attention.md "The command line"), two forms:
 *
 * - `watch <run> --role R --jsonl`: the role's projected events (`Runtime.watchRun`) from the first, one JSON line each,
 *   in order, and the command ends. There is no audit audience here, and no `--follow` (following a run is polling with
 *   the cursor `next`, which is not a command of 0.7).
 * - `watch --member M --out DIR [--follow] [--interval 10s] [--refresh SECONDS]`: script-free pages in DIR (person.ts),
 *   once, or with `--follow` again every `--interval` until SIGINT or SIGTERM, which stop it between two passes.
 *
 * Exit 1 when a page could not be made (it is said on standard error) or a refusal; 2 for a usage error.
 */
async function watch(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void, env: NodeJS.ProcessEnv, made: (rt: Runtime) => void): Promise<number> {
  if (a.flags["--audit"] !== undefined) throw new Usage("watch has no audit audience: it shows a role or a member what they may be shown");
  if (a.positional.length > 1) throw new Usage("watch takes one run: mandate watch <run> --role R --jsonl");
  const [run] = a.positional;
  const given = (...flags: string[]): string | undefined => flags.find((f) => a.flags[f] !== undefined);
  if (run !== undefined) {
    const wrong = given("--member", "--out", "--refresh", "--interval", "--follow");
    if (wrong !== undefined) throw new Usage(`${wrong} is for the pages: mandate watch --member M --out DIR [--follow] [--interval 10s] [--refresh SECONDS]; the events of a run are mandate watch <run> --role R --jsonl, which prints what there is and ends`);
    if (a.flags["--jsonl"] !== true) throw new Usage("watch <run> prints events as JSON lines: mandate watch <run> --role R --jsonl");
    const role = a.flags["--role"];
    if (typeof role !== "string") throw new Usage("--role R is required: the role whose projection of the run is printed");
    const { rt } = await runtimeFor(db, config, "watch", run, env);
    made(rt);
    let after = 0;
    for (;;) {
      const w = await rt.watchRun(run, { role }, { afterSeq: after, limit: WATCH_LIMIT });
      for (const e of w.events) out(jsonText(e) + "\n");
      if (w.next === after) return 0;
      after = w.next;
    }
  }
  const wrong = given("--role", "--jsonl");
  if (wrong !== undefined) throw new Usage(`${wrong} is for the events of a run: mandate watch <run> --role R --jsonl`);
  const member = a.flags["--member"];
  if (typeof member !== "string") throw new Usage("watch needs --member M --out DIR (pages), or a run with --role R --jsonl (events)");
  if (typeof a.flags["--out"] !== "string") throw new Usage("--out DIR is required: the directory the pages are written in");
  const dir = resolve(a.flags["--out"]);
  const follow = a.flags["--follow"] === true;
  const intervalMs = intervalOf(a, follow);
  const asked = a.flags["--refresh"];
  if (asked !== undefined && !/^[1-9][0-9]{0,4}$/.test(String(asked))) throw new Usage("--refresh is a number of seconds, 1 to 99999: the pages reload themselves that often; without it they do not");
  const refresh = asked === undefined ? undefined : Number(asked);
  const rt = readerRuntime(config, db);
  made(rt);
  const state: PagesState = { content: new Map(), runs: new Map() };
  const once = async (): Promise<PassResult> => {
    const r = await pass(rt, member, dir, { ...(refresh !== undefined ? { refresh } : {}), state });
    for (const p of r.problems) process.stderr.write(`mandate: ${p}\n`);
    if (r.written.length) out(`watch: wrote ${r.written.length === 1 ? "1 file" : `${r.written.length} files`} in ${terminalText(dir)}: ${r.written.join(", ")}\n`);
    return r;
  };
  if (!follow) return (await once()).problems.length ? 1 : 0;
  const stop = new AbortController();
  const interrupt = (): void => stop.abort();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let passes = 0;
  let failed = false;
  try {
    while (!stop.signal.aborted) {
      try {
        failed = (await once()).problems.length > 0;
      } catch (e) {
        failed = true;
        process.stderr.write(`mandate: a pass failed: ${terminalText(e instanceof Error ? e.message : String(e))}; the next one comes in ${intervalMs} ms\n`);
      }
      passes++;
      await sleep(intervalMs, stop.signal);
    }
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
  out(`watch: stopped after ${passes === 1 ? "1 pass" : `${passes} passes`}\n`);
  return failed ? 1 : 0;
}

/** Standard input as lines, from one reader for every prompt (a reader made for each would drop what it had buffered). */
function stdinLines(): { lines: AsyncIterator<string>; close: () => void } {
  const reader = createInterface({ input: process.stdin, terminal: false });
  return { lines: reader[Symbol.asyncIterator](), close: () => reader.close() };
}

/**
 * The open waits of the person who holds `key`: for each member the key is listed under in a package's lock (or the
 * member `--member` names), the waits `listWaits` gives that member, kept where that package's lock lists the key under
 * that member, as the lock says per wait. Sorted as `listWaits` sorts.
 */
async function waitsOfKey(reader: Runtime, db: Db, key: EvidenceSigner, explicit: string | undefined): Promise<WaitItem[]> {
  const locks = new Map((await db.query<{ package_hash: string; lock: Lock }>("select package_hash, lock from packages")).map((p) => [p.package_hash, p.lock] as const));
  const members = [...new Set([...locks.values()].map((l) => memberOf(l, key.keyId)).filter((m): m is string => m !== undefined))].sort();
  // `--member` names who signs: the key must be listed under that member in a package's lock, which is said before anything is asked.
  if (explicit !== undefined && !members.includes(explicit)) throw new Violation("invalid_decision", `unknown_key: no package's lock lists key ${key.keyId} under member ${explicit}, so nothing could be signed for them with it.`);
  const seen = new Map<string, WaitItem>();
  for (const member of explicit !== undefined ? [explicit] : members) {
    for (const item of await reader.listWaits({ member })) {
      const lock = locks.get(item.package);
      if (lock !== undefined && memberOf(lock, key.keyId) === member) seen.set(`${item.run}\u0000${item.command}\u0000${item.role ?? ""}`, item);
    }
  }
  return [...seen.values()].sort((x, y) => x.since - y.since || (x.run < y.run ? -1 : x.run > y.run ? 1 : 0) || (x.command < y.command ? -1 : x.command > y.command ? 1 : 0) || ((x.role ?? "") < (y.role ?? "") ? -1 : 1));
}

/**
 * `mandate decide --key FILE [--member NAME]` (spec/attention.md "The command line"): lists the open waits of whoever
 * holds the key, shows the one chosen as its role is shown it (masked above the role's cap, with each value's class and
 * how it is known, its deadline and what happens with no answer), asks for a choice and for a confirmation, signs, and
 * submits through the very paths `approve`, `decline`, `answer`, `review` and `amend` use (`signedFor`, then
 * `decideAction`, `submitInput`, `decideReview`, `decideAmendment`). It adds no check and removes none: the runtime
 * refuses what it would refuse from any client, and a refusal is printed with its reason, nothing retried.
 *
 * It reads one line of `input` (standard input) per prompt, in this order: the wait's number in the list; for a decision
 * or an amendment `approve` or `decline`; for a question the text of the answer; for a review each open item in turn,
 * `waive` or `decline` (or, at the first, every item in one line: `waive 0,2 decline 1`); then `yes` (or `y`) to sign.
 * Anything else, and the end of the input before the confirmation, signs nothing. When what is asked is masked for the
 * member's role, the confirmation says so and takes only `yes`. The subject it signs is obtained from `Runtime.shown`, as
 * `approve` obtains it: a role the wait is masked from cannot read it from a listing, and is not shown it here.
 *
 * It signs for the revision the list showed, so a run that has moved on is refused as `stale_revision`. Exit 0 when the
 * decision was taken; 1 when it was refused, cancelled or could not be made; 2 for a usage error or an answer not understood.
 */
async function decide(a: Args, config: RuntimeConfig, db: Db, out: (s: string) => void, env: NodeJS.ProcessEnv, input: AsyncIterable<string> | undefined, made: (rt: Runtime) => void): Promise<number> {
  if (a.positional.length) throw new Usage("decide takes no run: mandate decide --key FILE [--member NAME]");
  if (typeof a.flags["--key"] !== "string") throw new Usage("--key FILE is required: a decision is signed");
  if (config.decisions.mode === "unsigned") throw new Usage("decide signs each decision with --key, and this configuration takes decisions in unsigned mode (decisions.mode): mandate approve <run> --by NAME takes them there");
  const key = readDecisionKey(a.flags["--key"]);
  const explicit = typeof a.flags["--member"] === "string" ? a.flags["--member"] : undefined;
  const reader = readerRuntime(config, db);
  made(reader);
  const items = await waitsOfKey(reader, db, key, explicit);
  const who = explicit !== undefined ? `member ${terminalText(explicit)}` : `key ${key.keyId}`;
  if (!items.length) {
    out(`nothing waits for ${who}\n`);
    return 0;
  }
  const reading = input === undefined ? stdinLines() : undefined;
  const lines = input !== undefined ? input[Symbol.asyncIterator]() : reading!.lines;
  const interactive = input === undefined && process.stdin.isTTY === true;
  // One line per prompt; the prompt is written without a line end, and a line that was piped in is echoed after it, so the transcript reads as a terminal's would.
  const ask = async (prompt: string): Promise<string | undefined> => {
    out(prompt);
    const r = await lines.next();
    if (r.done) {
      out("\n");
      return undefined;
    }
    const line = String(r.value).replace(/\r$/, "");
    if (!interactive) out(terminalText(line) + "\n");
    return line;
  };
  const cancelled = (why: string): number => {
    out(`${why}; nothing was signed\n`);
    return 1;
  };
  const notUnderstood = (said: string, wanted: string): never => {
    throw new Unchecked(`${JSON.stringify(terminalText(said))} is not ${wanted}; nothing was signed`);
  };
  try {
    out([`${items.length === 1 ? "1 open decision" : `${items.length} open decisions`} for ${who}:`, ...items.map((item, i) => waitListLine(item, i + 1))].join("\n") + "\n");
    const picked = await ask(`Which one? [1-${items.length}] `);
    if (picked === undefined) return cancelled("the input ended before a wait was chosen");
    if (!/^[1-9][0-9]*$/.test(picked.trim()) || Number(picked.trim()) > items.length) return notUnderstood(picked, `a number from 1 to ${items.length}`);
    const item = items[Number(picked.trim()) - 1]!;
    const { rt, lock } = await runtimeFor(db, config, "decide", item.run, env);
    made(rt);
    const member = explicit ?? memberOf(lock, key.keyId);
    if (member === undefined) throw new Violation("invalid_decision", `unknown_key: the lock of run ${item.run}'s package lists key ${key.keyId} under no member.`);
    // The subject this signs is the wait's digest as the run shows it now, obtained as `approve` obtains it. The run takes
    // a decision on one wait at a time, the one it shows (a `par` can leave several open).
    const now = await rt.shown(item.run, "wait");
    if (now.command !== item.command) {
      return cancelled(`run ${terminalText(item.run)} has more than one wait open and takes a decision on ${terminalText(now.command ?? "another one")} first; this one, ${terminalText(item.command)}, can be decided once that one is`);
    }
    // What the role's view of the run holds of the wait: the runtime's own members of its request (what an item of a review failed, an amendment's changes).
    let request: Obj | undefined;
    // A member of no role has no view of the run: the wait as listed is what they are shown.
    if (item.role !== null) try {
      const w = ((await runView(rt, item.run, { role: item.role })).view as unknown as { waiting: Value }).waiting;
      if (isObj(w) && w["command"] === item.command && isObj(w["request"] ?? null)) request = w["request"] as Obj;
    } catch (e) {
      // A role the lock binds and the program does not name has no view.
      if (!(e instanceof Violation)) throw e;
    }
    const masked = hidesFromRole(item);
    const shownOut = [...waitLines(item, undefined, !(item.kind === "review" && request))];
    if (masked) shownOut.push(`  what you are asked to decide is masked for ${item.role === null ? "a member of no role" : terminalText(item.role)}: it is above what ${item.role === null ? "such a member" : "that role"} may be shown, so its value is not printed, only its class and how it is known`);
    const open = item.kind === "review" && request ? openItems(request) : [];
    if (item.kind === "review") {
      if (!request) return cancelled("the role's view of the run does not hold this review, so its items cannot be shown");
      shownOut.push(...open.flatMap((o, i) => openItemLines(item, o, i)));
    } else if (request) shownOut.push(...requestLines(item.kind, request));
    out("\n" + shownOut.join("\n") + "\n\n");

    let kind: DecisionKind;
    let payload: string | undefined;
    let what: string;
    let submit: (msg: { sender: string; messageId: string }, signed: SignedDecision) => Promise<RunRow>;
    if (item.kind === "decision" || item.kind === "amendment") {
      const said = await ask(`${item.kind === "amendment" ? "Approve or decline the amendment" : "Approve or decline"}? [approve/decline] `);
      if (said === undefined) return cancelled("the input ended before a choice was made");
      const choice = said.trim().toLowerCase();
      if (choice !== "approve" && choice !== "decline") return notUnderstood(said, "approve or decline");
      kind = item.kind === "amendment" ? (choice === "approve" ? "amend" : "decline") : choice;
      what = choice;
      submit = item.kind === "amendment" ? (msg, signed) => rt.decideAmendment(item.run, msg, signed) : (msg, signed) => rt.decideAction(item.run, msg, { signed });
    } else if (item.kind === "input") {
      const text = await ask("Your answer: ");
      if (text === undefined) return cancelled("the input ended before an answer was given");
      if (text === "") throw new Unchecked("an answer needs text; nothing was signed");
      kind = "answer";
      payload = payloadOf.answer(text);
      what = `answer ${shownSafe(text)}`;
      submit = (msg, signed) => rt.submitInput(item.run, msg, { value: text, signed });
    } else {
      const lists = await askReview(open.map((o) => o.index), ask);
      if (lists === undefined) return cancelled("the input ended before every item was decided");
      kind = "review";
      payload = payloadOf.review(lists);
      what = `waive ${lists.waive.join(",") || "nothing"}, decline ${lists.decline.join(",") || "nothing"}`;
      submit = (msg, signed) => rt.decideReview(item.run, msg, { ...lists, signed });
    }
    const role = now.role !== undefined ? terminalText(now.role) : "a member the lock lists";
    out(`About to sign as ${terminalText(member)} (${role}): ${what}\n  run ${terminalText(item.run)}, wait ${terminalText(item.command)}, revision ${item.revision}\n`);
    if (masked) {
      out(`  You are deciding on something you are not shown: what this asks is above what ${item.role === null ? "a member of no role" : terminalText(item.role)} may be shown. It is signed for its digest all the same.\n`);
      const said = await ask("Type yes to sign it anyway: ");
      if (said === undefined || said.trim().toLowerCase() !== "yes") return cancelled(said === undefined ? "the input ended before the confirmation" : "not confirmed");
    } else {
      const said = await ask("Sign and submit? [y/N] ");
      const answer = said?.trim().toLowerCase();
      if (answer !== "y" && answer !== "yes") return cancelled(said === undefined ? "the input ended before the confirmation" : "not confirmed");
    }
    // Signed for the revision the list showed: a run that has moved on since is refused by the runtime as stale.
    const signed = await signedFor(rt, item.run, key, member, "wait", kind, payload, () => item.revision);
    let run: RunRow;
    try {
      run = await submit({ sender: member, messageId: randomUUID() }, signed);
    } catch (e) {
      if (e instanceof InvalidDecision && e.reason === "stale_revision") throw new Violation("stale_revision", `${e.message.slice("stale_revision: ".length)} The run moved on after the list was shown; nothing was decided. Run mandate decide again to see what it asks now.`);
      throw e;
    }
    out(`decision  ${decisionId(signed.record)}\nsigned by ${terminalText(member)}: ${what}\nrun ${terminalText(run.run_id)} is now ${run.state}, revision ${run.revision}\n`);
    return 0;
  } finally {
    reading?.close();
  }
}

/**
 * The open items of a review, each waived or declined: one line `waive 0,2 decline 1` for all of them (a script's form),
 * or one answer per item in turn, `waive` or `decline`. Undefined when the input ends. An answer that is neither is not
 * understood (`Unchecked`). Whether the lists decide every item exactly once is the runtime's to say.
 */
async function askReview(indices: number[], ask: (prompt: string) => Promise<string | undefined>): Promise<{ waive: number[]; decline: number[] } | undefined> {
  const lists = { waive: [] as number[], decline: [] as number[] };
  const first = await ask(`Decide every open item (${indices.join(", ")}) once. All in one line, \`waive 0,2 decline 1\`, or item ${indices[0] ?? "?"} first [waive/decline]: `);
  if (first === undefined) return undefined;
  const words = first.trim().toLowerCase().split(/\s+/);
  if (words.length > 1) {
    for (let i = 0; i < words.length; i += 2) {
      const list = words[i + 1];
      if ((words[i] !== "waive" && words[i] !== "decline") || list === undefined || !/^[0-9]+(,[0-9]+)*$/.test(list)) throw new Unchecked(`${JSON.stringify(terminalText(first))} is not \`waive 0,2 decline 1\`; nothing was signed`);
      lists[words[i] as "waive" | "decline"].push(...list.split(",").map(Number));
    }
    return lists;
  }
  let said: string | undefined = first;
  for (const [n, index] of indices.entries()) {
    if (n > 0) said = await ask(`item ${index} [waive/decline]: `);
    if (said === undefined) return undefined;
    const choice = said.trim().toLowerCase();
    if (choice !== "waive" && choice !== "decline") throw new Unchecked(`${JSON.stringify(terminalText(said))} is not waive or decline; nothing was signed`);
    lists[choice].push(index);
  }
  return lists;
}
