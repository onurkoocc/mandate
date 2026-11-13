// The control CLI (Doc 4 §16.1; BACKLOG K19): a person runs a program and
// answers it from a terminal, until the views of P2-14 exist.
//
//   mandate run <program> --workflow W --input <json> [--run-id ID] [--limit spend=20USD,tokens=2M]
//   mandate status <run> [--json]
//   mandate key new [--out FILE]                          a key of your own, to sign decisions with
//   mandate approve-envelope <program> --key FILE [--member NAME] [--workflow W]
//                                                         approve a package's envelope, so its runs may start
//   mandate approve <run> --revision N --key FILE [--member NAME]
//   mandate decline <run> --revision N --key FILE [--member NAME]
//   mandate answer <run> --revision N --key FILE [--member NAME] <text>
//   mandate cancel <run> [--key FILE]
//   mandate reconcile <run> <operation> [--key FILE]      ask the system of record what an unknown outcome was
//   mandate raise-limits <run> --revision N --key FILE [--member NAME] --limit spend=30USD
//   mandate amend <run> --revision N --key FILE [--member NAME] (approve | decline)
//                                                         decide an amendment of the envelope a lead asked for
//   mandate decision <run> <digest>                       a decision the run took, as its signed record
//   mandate verify-decision <record.json> --key <public key.pem> [--lock FILE]
//                                                         check a decision's signature; no configuration, no database
//   mandate journal export <run> [--out FILE]            the run's journal as an outsider checks it (spec/journal.md)
//   mandate journal key [--out FILE]                      the public keys its anchors are signed with
//   mandate journal verify <export.json> --key <public key.pem> [--key …] [--json]
//                                                         check a journal's chain and anchors; no configuration, no database
//   mandate replay <run>
//   mandate artifact <run> <blob:sha256:…>
//   mandate show <run> [--format md|html|json]           the run's views (§15): status, evidence, cost, actions
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
import { check, kindOf, linkedProgram, loadModules, LOCK_FORMAT, packagedLock, parseStrictJson, printProgram, toHtml, toMarkdown, type Lock, type Modules, type Program } from "@mandate/compiler";
import { adaptersFor, anthropicClient, connect, readConfig, runtimeOptions, trustedKeyTexts, trustedKeysDir, type RuntimeConfig } from "./control.js";
import { deployManagedAgents, sdkApi } from "./managed-agents.js";
import { decisionId, isSignedDecision, keyFileName, memberOf, newDecisionKey, payloadOf, readDecisionKey, roleRefusal, shownPackage, signatureHolds, signDecision, signerRefusal, type DecisionKind, type SignedDecision } from "./decisions.js";
import { EvidenceSigner, keyIdOf, TrustedKeys } from "./evidence.js";
import { openDb, type Db } from "./db.js";
import { serveUntilSignalled } from "./egress/main.js";
import { costDims, type Limits, type RunRow } from "./journal.js";
import { exportJournal, parseExportJson, publicKeysIn, readExport, verifyExport, type FindingCode } from "./journal-chain.js";
import { draft, drift, scan, type RepoFacts } from "./onboard.js";
import { buildPackage, Runtime } from "./runtime.js";
import { Violation } from "./signals.js";
import { runTests } from "./testing.js";
import { runDoc, runView, shadowDiff } from "./views.js";
import { isObj, show, type Obj, type Value } from "./values.js";

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

const VALUED = new Set(["--mode", "--priority", "--config", "--workflow", "--input", "--run-id", "--limit", "--revision", "--by", "--lock", "--message-id", "--format", "--name", "--target", "--agents", "--harness-tokens", "--key", "--member", "--out"]);
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
  mandate run <program> --workflow W --input <json|file> [--run-id ID] [--limit spend=20USD,tokens=2M] [--lock FILE] [--module FILE]… [--priority high|normal] [--mode design|read_only|live]
  mandate shadow-diff <run> <other run>
  mandate status <run> [--json]
  mandate key new [--out FILE]
  mandate approve-envelope <program> --key FILE [--member NAME] [--workflow W] [--lock FILE] [--module FILE]… [--json]
  mandate approve <run> --revision N --key FILE [--member NAME]
  mandate decline <run> --revision N --key FILE [--member NAME]
  mandate answer <run> --revision N --key FILE [--member NAME] <text>
  mandate cancel <run> [--key FILE]
  mandate reconcile <run> <operation> [--key FILE]
  mandate raise-limits <run> --revision N --key FILE [--member NAME] --limit spend=30USD
  mandate amend <run> --revision N --key FILE [--member NAME] (approve | decline)
  mandate decision <run> <digest>
  mandate verify-decision <record.json> --key <public key.pem> [--lock FILE]
  mandate journal export <run> [--out FILE]
  mandate journal key [--out FILE]
  mandate journal verify <export.json> --key <public key.pem> [--key FILE]… [--json]
  mandate replay <run>
  mandate artifact <run> <blob:sha256:…>
  mandate show <run> [--format md|html|json]
  mandate denials <run>
  mandate rotate-key
  mandate test <program> [--json] [--lock FILE]
  mandate onboard --component NAME=DIR… [--host HOST=NAME]… [--repo NAME=OWNER/REPO]… [--name MODULE]
  mandate drift --module MODEL --component NAME=DIR… [--host HOST=NAME]… [--json]
  mandate deploy <program> --target managed-agents [--lock FILE] [--module FILE]… [--agents A,B] [--name PREFIX] [--harness-tokens N]
  mandate egress serve [--config FILE (default ./mandate.egress.json)]
options: --config FILE (default ./mandate.runtime.json), --json, --message-id ID
a decision is signed with --key; in unsigned mode (decisions.mode in the configuration) it takes --by NAME instead`;

export const CONTROL_COMMANDS = new Set(["run", "status", "approve", "decline", "answer", "cancel", "reconcile", "shadow-diff", "raise-limits", "replay", "artifact", "show", "denials", "rotate-key", "test", "onboard", "drift", "deploy", "key", "decision", "verify-decision", "approve-envelope", "amend", "journal", "egress"]);

/** Runs one control command; returns the exit status. */
export async function main(argv: string[], out: (s: string) => void = (s) => process.stdout.write(s), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let db: Db | undefined;
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
      const { program, lock, modules } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined, a.modules);
      const rt = new Runtime(db, adaptersFor(config, linkedProgram(program, modules), lock, env), undefined, undefined, runtimeOptions(config, db));
      const run = await rt.startRun({
        pkg: buildPackage(program, lock, modules),
        workflow,
        input: input(str(a, "--input")),
        ...(typeof a.flags["--run-id"] === "string" ? { runId: a.flags["--run-id"] } : {}),
        ...(typeof a.flags["--limit"] === "string" ? { limits: limits(a.flags["--limit"]) } : {}),
        ...(a.flags["--priority"] === "high" || a.flags["--priority"] === "normal" ? { priority: a.flags["--priority"] } : {}),
        ...(a.flags["--mode"] !== undefined ? { mode: runMode(a.flags["--mode"]) } : {}),
      });
      out(await report(rt, run, json, config));
      return 0;
    }

    if (cmd === "journal") return await journal(a, config, db, out);

    if (cmd === "approve-envelope") {
      // A member of the envelope's owner role signs for the package hash its card shows (`mandate view --card`).
      const file = a.positional[0] ?? fail("approve-envelope needs a program file");
      const { program, lock, modules } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined, a.modules);
      const owner = envelopeOwner(program, file, typeof a.flags["--workflow"] === "string" ? a.flags["--workflow"] : undefined);
      const key = readDecisionKey(str(a, "--key"));
      const member = typeof a.flags["--member"] === "string" ? a.flags["--member"] : memberOf(lock, key.keyId);
      if (member === undefined) throw new Violation("invalid_decision", `unknown_key: the lock of ${file} lists key ${key.keyId} under no member.`);
      const pkg = buildPackage(program, lock, modules);
      const rt = new Runtime(db, adaptersFor(config, linkedProgram(program, modules), lock, env), undefined, undefined, runtimeOptions(config, db));
      const signed = signDecision(key, shownPackage(pkg.hash, owner), { kind: "envelope", member, at: new Date() });
      const decision = await rt.approveEnvelope(pkg, signed);
      out(json ? JSON.stringify({ package: pkg.hash, decision, member, role: owner, key: key.keyId, record: signed.record, signature: signed.signature }, null, 2) + "\n" : `package  ${pkg.hash}\napproved by ${member} as ${owner}\ndecision ${decision}\n`);
      return 0;
    }

    if (!runId) throw new Usage(`${cmd} needs a run id`);
    const { rt, lock } = await runtimeFor(db, config, runId, env);
    // Who decides: a member, by the key they sign with (the lock says whose it is), or in unsigned mode a name.
    const key = typeof a.flags["--key"] === "string" ? readDecisionKey(a.flags["--key"]) : undefined;
    const member = key ? (typeof a.flags["--member"] === "string" ? a.flags["--member"] : memberOf(lock, key.keyId)) : undefined;
    if (key && member === undefined) throw new Violation("invalid_decision", `unknown_key: the lock of run ${runId}'s package lists key ${key.keyId} under no member.`);
    const msg = { sender: member ?? (typeof a.flags["--by"] === "string" ? a.flags["--by"] : "cli"), messageId: typeof a.flags["--message-id"] === "string" ? a.flags["--message-id"] : randomUUID() };
    /** The person's signed record of a decision on what the run shows; it names the revision they saw (--revision). */
    const sign = async (about: "wait" | "run" | { reconcile: string }, kind: DecisionKind, payload?: string): Promise<SignedDecision> => {
      const shown = await rt.shown(runId, about);
      const seen = typeof a.flags["--revision"] === "string" ? revision(a) : shown.revision;
      return signDecision(key!, { ...shown, revision: seen }, { kind, member: member!, ...(payload !== undefined ? { payload } : {}), at: new Date() });
    };
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
        run = await rt.raiseLimits(runId, msg, key ? { limits: wanted, signed: await sign("run", "raise_limits", payloadOf.limits(costDims(wanted))) } : { revision: rev, limits: wanted, by: by() });
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
        const { view, program } = await runView(rt, runId);
        out(format === "json" ? JSON.stringify(view, null, 2) + "\n" : format === "html" ? toHtml(runDoc(view, program)) : toMarkdown(runDoc(view, program)));
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
      process.stderr.write(`mandate: ${e.message}\n${USAGE}\n`);
      return 2;
    }
    if (e instanceof Unchecked) {
      process.stderr.write(`mandate: ${e.message}\n`);
      return 2;
    }
    if (e instanceof Violation) {
      // A violation's message starts with its code.
      process.stderr.write(`mandate: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    await db?.close();
  }
}

/** Runs a program's tests against their handlers, on an in-process database of their own; exit 1 if any fails. */
async function test(a: Args, out: (s: string) => void): Promise<number> {
  const file = a.positional[0] ?? fail("test needs a program file");
  const { program, lock } = load(file, typeof a.flags["--lock"] === "string" ? a.flags["--lock"] : undefined);
  const db = await openDb();
  try {
    const results = await runTests(program, { db, dir: dirname(file), lock });
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
  for (const [name, d] of Object.entries(program.defs)) if (d.kind === "workflow" && d.envelope?.owner !== undefined) owners.set(name, d.envelope.owner);
  const all = [...owners.keys()].sort();
  if (!all.length) throw new Violation("no_envelope", `${file} has no workflow with an envelope, so there is nothing to approve.`);
  if (workflow !== undefined) return owners.get(workflow) ?? fail(`no workflow ${workflow} with an envelope in ${file}; it has ${all.join(", ")}`);
  const roles = [...new Set(owners.values())].sort();
  if (roles.length > 1) throw new Usage(`${file} has envelopes owned by ${roles.join(" and ")}; name the workflow whose envelope you approve with --workflow: ${all.join(", ")}`);
  return roles[0]!;
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

/** `spend=20USD,tokens=2M,steps=40,agents=30`. */
function limits(text: string): Limits {
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
    else throw new Usage(`unknown limit ${k}; use spend, tokens, steps or agents`);
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

/** The program, checked, and its lock: --lock, or mandate.lock.json next to it (or `given`, already read). */
function load(file: string, lockFile: string | undefined, moduleFiles: string[] = [], given?: Lock): { program: Program; lock: Lock; modules: Modules } {
  const lock = given ?? readLock(lockFile ?? join(dirname(file), "mandate.lock.json"));
  const { modules, problems } = loadModules(moduleFiles.map((f) => ({ file: f, text: readFileSync(f, "utf8"), kind: kindOf(f) })));
  if (problems.length) throw new Violation("load_verification_failed", problems.flatMap((p) => p.diagnostics.filter((d) => d.severity === "error").map((d) => `${p.file}: ${d.code} ${d.message}`)).join("\n"));
  const r = check(readFileSync(file, "utf8"), kindOf(file), { modules, ...(lock ? { lock } : {}) });
  if (!r.ok) throw new Violation("load_verification_failed", r.diagnostics.filter((d) => d.severity === "error").map((d) => `${d.code} ${d.message}`).join("\n"));
  return { program: r.program!, lock: packagedLock(lock), modules };
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
  const { program, modules } = load(file, undefined, a.modules, unbound);
  const agents = typeof a.flags["--agents"] === "string" ? a.flags["--agents"].split(",").map((x) => x.trim()).filter(Boolean) : undefined;
  const harness = typeof a.flags["--harness-tokens"] === "string" ? Number(a.flags["--harness-tokens"]) : undefined;
  if (harness !== undefined && (!Number.isInteger(harness) || harness < 0)) throw new Usage("--harness-tokens takes a whole number");
  const binding = await deployManagedAgents({
    program: linkedProgram(program, modules),
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

/** The runtime for a run's package, and the package's lock: it says which member a key belongs to. */
async function runtimeFor(db: Db, config: RuntimeConfig, runId: string, env: NodeJS.ProcessEnv): Promise<{ rt: Runtime; lock: Lock }> {
  const [row] = await db.query<{ program: Program; lock: Lock; modules: Modules | null }>("select p.program, p.lock, p.modules from runs r join packages p on p.package_hash = r.package_hash where r.run_id = $1", [runId]);
  if (!row) throw new Violation("unknown_run", `No run ${runId}.`);
  return { rt: new Runtime(db, adaptersFor(config, linkedProgram(row.program, row.modules ?? {}), row.lock, env), undefined, undefined, runtimeOptions(config, db)), lock: row.lock };
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
  const problem = !isSignedDecision(signed)
    ? `${file} is not a signed decision record ({ "record": …, "signature": "ed25519:…" })`
    : signed.record.key !== keyId
      ? `the record names key ${signed.record.key}; ${keyFile} holds ${keyId}`
      : !signatureHolds(signed, keys)
        ? `the signature does not verify under key ${keyId}: the record is not what was signed`
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
  const lines = [`run ${run.run_id}  ${run.workflow}  ${run.state}  revision ${run.revision}`];
  if (run.state === "waiting" && isObj(run.waiting)) {
    const w = run.waiting;
    const req = isObj(w["request"] ?? null) ? (w["request"] as Obj) : {};
    if (w["kind"] === "decision" && "criterion" in req) {
      lines.push(`waiting for: ${req["role"] ?? "a person"} to approve ${req["contract"]}.${req["criterion"]}`);
      lines.push(`  subject digest ${req["subject_digest"]}${typeof req["deadline"] === "number" ? `, deadline ${new Date(req["deadline"]).toISOString()}` : ""}`);
      lines.push(...subjectLines(req["subject"] ?? null));
      if (config.verifier) lines.push(`  the change in ${config.verifier.workdir}: git -C ${config.verifier.workdir} diff ${config.verifier.base}`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} ${as}`, `  decline: mandate decline ${run.run_id} --revision ${run.revision} ${as}`);
    } else if (w["kind"] === "amendment") {
      // What the owner signs for is the new package's hash. The reason is the lead's own text: a model wrote it.
      lines.push(`waiting for: ${req["role"] ?? "the owner"} to decide an amendment of ${req["workflow"]}'s envelope, asked by ${req["lead"]}`);
      lines.push(`  package ${req["from"]} → ${req["package"]}${typeof req["deadline"] === "number" ? `, deadline ${new Date(req["deadline"]).toISOString()}` : ""}`);
      const changes = Array.isArray(req["changes"]) ? req["changes"] : [];
      for (const c of changes) if (isObj(c)) lines.push(`  ${String(c["text"])}`);
      if (!changes.length) lines.push("  the envelope's amounts and capabilities are as they were");
      lines.push(`  the lead's reason (model output): ${JSON.stringify(String(req["reason"] ?? ""))}`);
      lines.push(`  approve: mandate amend ${run.run_id} --revision ${run.revision} ${as} approve`, `  decline: mandate amend ${run.run_id} --revision ${run.revision} ${as} decline`);
    } else if (w["kind"] === "timer") {
      lines.push(`waiting for: a timer until ${typeof req["until"] === "number" ? new Date(req["until"]).toISOString() : "?"} (${String(req["reason"] ?? "")}); the scheduler resumes the run then`);
    } else if (w["kind"] === "decision") {
      lines.push(`waiting for: approval of action ${req["effect"] ?? ""} (digest ${req["action_digest"]})`);
      lines.push(`  approve: mandate approve ${run.run_id} --revision ${run.revision} ${as}`);
    } else {
      const q = req["question"] ?? req["escalation"] ?? (w["kind"] === "budget_exceeded" ? "Budget exceeded." : null);
      lines.push(`waiting for: an answer${q !== null ? `: ${show(q as Value)}` : ""}`);
      if (w["kind"] === "budget_exceeded") lines.push(`  raise:  mandate raise-limits ${run.run_id} --revision ${run.revision} ${as} --limit spend=<amount>USD`);
      lines.push(`  answer: mandate answer ${run.run_id} --revision ${run.revision} ${as} <text>`);
    }
  }
  if (run.state === "attention_required") lines.push(`attention: ${show(run.attention ?? null)}`);
  if (run.state === "failed") lines.push(`error: ${show(run.error ?? null)}`);
  if (run.state === "succeeded") lines.push(`result: ${show(run.result ?? null)}`);
  for (const d of budget.dimensions) {
    const money = d.dimension.startsWith("spend:");
    const f = (n: number) => (money ? `${(n / 1_000_000).toFixed(4)} ${d.dimension.slice(6)}` : String(n));
    lines.push(`budget ${d.dimension}: limit ${f(d.limit)}, settled ${f(d.settled)}, reserved ${f(d.reserved)}, available ${f(d.available)}`);
  }
  for (const e of evidence) lines.push(`evidence ${e.contract}.${e.criterion}: ${e.passed ? "met" : "not met"} (${e.method}; ${signed.get(e.evidence_id) ? "signed" : "SIGNATURE INVALID"})`);
  for (const d of decisions) lines.push(`decision ${d.record.kind} by ${d.record.member}${d.record.role !== undefined ? ` as ${d.record.role}` : ""}: ${d.valid ? "signed" : "SIGNATURE INVALID"} (${d.decision_id})`);
  for (const x of actions) lines.push(`action ${x.effect}: ${x.state}${x.receipt ? ` ${show(x.receipt)}` : ""}`);
  return lines.join("\n") + "\n";
}

function subjectLines(subject: Value): string[] {
  const parts = Array.isArray(subject) ? subject : [subject];
  const out: string[] = [];
  for (const p of parts) {
    if (!isObj(p)) continue;
    for (const k of ["issue", "patch", "tests", "review"]) {
      const v = p[k];
      if (v !== undefined) out.push(`  ${k}: ${show(v).slice(0, 600)}`);
    }
  }
  return out;
}
