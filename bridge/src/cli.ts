#!/usr/bin/env node
// mandate — the command line (language 0.1 to 0.6), written over the bridge's entry point (./index.js), so that it
// follows the bridge to whichever compiler stands behind it. The TypeScript compiler keeps its own copy as `mandate-ts`.
//
//   mandate check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
//                                          validate, resolve names, print hashes
//   mandate ir <file> [--canonical]        print canonical IR (pretty, or the exact JCS bytes)
//   mandate fmt <file>                     print the .mdt projection of the IR
//   mandate hash <file>                    print program and definition hashes
//   mandate patch <program> <patch.json>   apply an IR patch (see `patch` below)
//   mandate sandbox <file> [--agent <name>] print each agent's sandbox requirement
//   mandate target acs <file> [--out <dir>] write each agent's ACS manifest and Rego policy
//                                          for an AGT host (spec/executors.md, item 40)
//   mandate explain <code>                 explain a diagnostic code
//   mandate mcp [--module <file>]…         serve check, explain, apply_patch and views to agents
//                                          over MCP on stdio (§14)
//   mandate view <file> [--against <old>] [--against-lock <old lock.json>] [--format md|html|json] [--lock <lock.json>]
//                                          the program's human views (§15): architecture,
//                                          authority and cost; with --against, what changed,
//                                          the two locks' members and roles included
//   mandate view <file> --card [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]…
//                                          the card a person reads before approving a
//                                          workflow's envelope, with the package hash
//                                          the approval binds to (spec/views.md)
//   mandate add <library>[@<range>] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--json]
//                                          pin a library of the operator's directory in the lock, and
//                                          show its authority signature (language 0.6, spec/library.md)
//   mandate upgrade <library>[@<range>] [--accept-governance] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--json]
//                                          pin a newer version; a change that widens the authority
//                                          signature is shown as a governance change, and the lock is
//                                          written only with --accept-governance
//   mandate publish <source dir> [--libraries <dir>] [--config <file>] [--json]
//                                          copy a library into the operator's directory and write its
//                                          index.json; a version that widens and is not a major one is
//                                          refused (MDT-E1607)
//
//   mandate run | status | approve | decline | answer | cancel | raise-limits | replay | artifact | show | denials | rotate-key
//                                          control a run (the runtime's CLI, @mandate/runtime/cli)
//   mandate key new | decision | verify-decision | approve-envelope | amend
//                                          a member's key, a decision as its signed record, the approval
//                                          of an envelope and the decision on its amendment (the runtime's CLI)
//   mandate journal export | key | verify  a run's chained journal, its keys, and its check (spec/journal.md)
//   mandate halt                           the operator's hard stop of a tenant or of all, its lift and
//                                          the list of halts (spec/boundary.md, the runtime's CLI)
//   mandate otel export --endpoint <url>   the journal as OpenTelemetry spans, without content (spec/boundary.md, the runtime's CLI)
//   mandate tick [--follow]                the driver loop: deadlines pass, reviews escalate, notifications of 0.7
//                                          runs go out (spec/attention.md, the runtime's CLI)
//   mandate promote <run> --to <mode>      the owner promotes a workflow up its ladder on a run (0.7, spec/attention.md, the runtime's CLI)
//   mandate egress serve --config <file>   the reference egress proxy, which holds the secrets (spec/egress.md)
//   mandate connector pin <program>        writes the schema digests of a program's connectors into its lock,
//                                          asking each server through the egress proxy (0.6, spec/library.md; the runtime's CLI)
//   mandate review <run> --revision N --key FILE --waive I,J --decline K
//                                          decide a review of a batch in one signed decision (0.6, spec/library.md;
//                                          the runtime's CLI)
//   mandate test <file>                    run the program's tests with their effect handlers (§6.4)
//
// <file> is .mdt text or .json canonical IR. `--module <file>` (repeatable)
// loads a module the program imports, such as a system model (design doc 9
// §2.1); `check`, `patch`, `sandbox` and `view` link it in. `check` and `sandbox` read the
// lock file named by --lock, or else mandate.lock.json next to <file> if there
// is one. `view --against` reads the old version's lock the same way, from
// --against-lock or else mandate.lock.json next to the old file. A lock of 0.6 that pins libraries has them read from
// the operator's directory, `<dir>/<name>/<version>/`: the one --libraries names, or else `libraries.dir` of the
// configuration (--config, or mandate.runtime.json of the working directory), whose revoked digests the check holds
// the pins to (MDT-E1608); `check`, `sandbox`, `target acs` and `view` hand them to the compiler. The library commands
// and these two options are as the native command line (crates/mandate-cli) has them: the same arguments give the
// same standard output, exit status and files. Exit status is 1 when any error diagnostic is reported, 2 on usage
// errors and when the compiler behind the bridge fails (a CompilerFailure: its module missing, trapping, out of
// memory, or answering what is not an answer), which is never read as a program that checks.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  acsTarget,
  applyPatch,
  architecture,
  authority,
  canonicalize,
  card,
  cardDoc,
  check,
  CODES,
  cost,
  denialDiagnostics,
  diffDoc,
  envelopeWorkflows,
  formatDiagnostic,
  hasErrors,
  kindOf,
  load,
  loadModules,
  parseStrictJson,
  printProgram,
  programDoc,
  sandboxRequirements,
  semanticDiff,
  toHtml,
  toMarkdown,
  type DenialReport,
  type Diagnostic,
  type Json,
  type Lock,
  type Modules,
  type PatchOp,
} from "./index.js";
import { given, givenOptions, libraryCommand, Stop, withModules, type Given, type Io, type LibraryArgs } from "./cli-library.js";
import { Files } from "./libraries.js";
import { serveStdio } from "./mcp.js";
import { viewModules } from "./util.js";
import { CompilerFailure } from "./wasm/errors.js";

/** What the command prints when it is not used as it is meant. */
function usageText(): string {
  return (
    [
      "usage: mandate <command> [options]",
      "  check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
      "  ir <file> [--canonical]",
      "  fmt <file>",
      "  hash <file>",
      "  patch <program> <patch.json> [--json]   patch.json: { \"base\": \"sha256:…\", \"ops\": [ … ] }",
      "  sandbox <file> [--agent <name>] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
      "  target acs <file> [--out <dir>] [--json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
      "  explain <code>",
      "  view <file> [--against <old file>] [--against-lock <old lock.json>] [--format md|html|json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
      "  view <file> --card [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]",
      "  add <library>[@<range>] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--json]",
      "  upgrade <library>[@<range>] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--accept-governance] [--json]",
      "  publish <source dir> [--libraries <dir>] [--config <file>] [--json]",
      "  mcp [--module <file>]…   (an MCP server on stdio)",
      "  run | status | approve | decline | answer | cancel | raise-limits | replay | artifact | show | denials | rotate-key   (see `mandate status`)",
      "  key new [--out FILE] | decision <run> <digest> | verify-decision <record.json> --key <public key.pem> [--lock FILE]",
      "  approve-envelope <file> --key FILE [--member NAME] [--workflow W] [--lock <lock.json>] [--module <file>]… [--libraries <dir>]",
      "  amend <run> --revision N --key FILE [--member NAME] (approve | decline)",
      "  journal export <run> [--out FILE] | journal key [--out FILE] | journal verify <export.json> --key <public key.pem>…",
      "  halt (--tenant T | --all) [--reason TEXT] [--by WHO] | halt --lift (--tenant T | --all) --by WHO | halt --list",
      "  otel export --endpoint <url> [--run R | --tenant T] [--follow] [--json]",
      "  egress serve --config <mandate.egress.json>   (the reference egress proxy)",
      "  connector pin <program> [--lock FILE] [--module FILE]… [--libraries DIR] [--config FILE]",
      "  review <run> --revision N --key FILE [--member NAME] [--waive I,J] [--decline K]",
      "  tick [--follow] [--interval 10s] [--no-notify]",
      "  promote <run> --to read_only|live --key FILE [--member NAME] [--yes]",
      "  test <file> [--json] [--libraries <dir>]",
      "",
    ].join("\n")
  );
}

function usage(): never {
  process.stderr.write(usageText());
  process.exit(2);
}

/** The process as a library command is run with it: its working directory, its clock and its two streams. */
const io: Io = {
  fs: new Files(),
  now: () => Math.floor(Date.now() / 1000),
  out: (text) => void process.stdout.write(text),
  err: (text) => void process.stderr.write(text),
};

/** What a check of a program with `lock` is given of the libraries the lock pins (0.6); a refusal ends the command. */
function givenFor(a: LibraryArgs, lock: Lock | undefined): Given {
  try {
    return given(io, a, lock);
  } catch (e) {
    if (e instanceof Stop) process.exit(e.code);
    throw e;
  }
}

/** The lock `readLock` would give, or none when there is none or it cannot be read: nothing is reported. */
function peekLock(file: string, named: string | undefined): Lock | undefined {
  try {
    const parsed = parseStrictJson(readFileSync(named ?? join(dirname(file), "mandate.lock.json"), "utf8"));
    return parsed.ok ? (parsed.value.value as unknown as Lock) : undefined;
  } catch {
    return undefined;
  }
}

function read(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (e) {
    process.stderr.write(`mandate: cannot read ${file}: ${(e as Error).message}\n`);
    process.exit(2);
  }
}

function report(diags: Diagnostic[], file: string, asJson: boolean, extra: Record<string, unknown> = {}): void {
  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: !hasErrors(diags), ...extra, diagnostics: diags }, null, 2) + "\n");
  } else {
    for (const d of diags) process.stderr.write(formatDiagnostic(d, file) + "\n");
  }
}

/** The lock named by --lock, or mandate.lock.json next to the program; strict JSON either way. */
function readLock(file: string, named: string | undefined, asJson: boolean): Lock | undefined {
  const path = named ?? join(dirname(file), "mandate.lock.json");
  if (!named && !existsSync(path)) return undefined;
  const parsed = parseStrictJson(read(path));
  if (!parsed.ok) {
    report(parsed.diagnostics, path, asJson);
    process.exit(1);
  }
  return parsed.value.value as unknown as Lock;
}

/** Removes `--name value` from args and returns the value. */
function option(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1] ?? usage();
  args.splice(at, 2);
  return value;
}

/** Removes every `--name value` from args and returns the values. */
function options(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let v = option(args, name); v !== undefined; v = option(args, name)) out.push(v);
  return out;
}

/** The modules named by --module, each checked against the others; any problem stops the command. */
function readModules(files: string[], asJson: boolean): Modules {
  const { modules, problems } = loadModules(files.map((file) => ({ file, text: read(file), kind: kindOf(file) })));
  for (const p of problems) report(p.diagnostics, p.file, asJson);
  if (problems.length) process.exit(1);
  return modules;
}

function main(argv: string[]): void {
  const [cmd, ...plain] = argv;
  const moduleFiles = options(plain, "--module");
  const agent = option(plain, "--agent");
  const lockFile = option(plain, "--lock");
  const outDir = option(plain, "--out");
  const against = option(plain, "--against");
  const againstLock = option(plain, "--against-lock");
  const denials = option(plain, "--denials");
  const workflow = option(plain, "--workflow");
  const format = option(plain, "--format") ?? "md";
  const librariesDir = option(plain, "--libraries");
  const configFile = option(plain, "--config");
  // 0.7: the program a lock is for (`add`, `upgrade`).
  const programFile = option(plain, "--program");
  const flags = new Set(plain.filter((a) => a.startsWith("--")));
  const args = plain.filter((a) => !a.startsWith("--"));
  const asJson = flags.has("--json");
  const modules = readModules(moduleFiles, asJson);
  /** The arguments the libraries are read by (0.6): the lock they are pinned in is each command's own. */
  const library: LibraryArgs = {
    positional: args,
    json: asJson,
    ...(lockFile !== undefined ? { lock: lockFile } : {}),
    ...(librariesDir !== undefined ? { libraries: librariesDir } : {}),
    ...(configFile !== undefined ? { config: configFile } : {}),
    acceptGovernance: flags.has("--accept-governance"),
    ...(programFile !== undefined ? { program: programFile } : {}),
  };

  switch (cmd) {
    case "check": {
      const file = args[0] ?? usage();
      const lock = readLock(file, lockFile, asJson);
      const r = check(read(file), kindOf(file), { modules, ...(lock ? { lock } : {}), ...givenOptions(givenFor(library, lock)) });
      // W0311: what sandboxes denied in learning mode, as feedback on the policies (§11.3).
      if (denials !== undefined && r.program && r.ok) {
        const parsed = parseStrictJson(read(denials));
        if (!parsed.ok) {
          report(parsed.diagnostics, denials, asJson);
          process.exit(1);
        }
        r.diagnostics.push(...denialDiagnostics(r.program, parsed.value.value as unknown as DenialReport));
        r.ok = !hasErrors(r.diagnostics);
      }
      report(r.diagnostics, file, asJson, r.hashes ? { hashes: r.hashes } : {});
      if (!asJson && r.ok) process.stdout.write(`ok ${r.hashes!.program}\n`);
      process.exit(r.ok ? 0 : 1);
    }
    // falls through (process.exit does not return)
    case "ir":
    case "fmt":
    case "hash": {
      const file = args[0] ?? usage();
      const r = cmd === "hash" ? check(read(file), kindOf(file)) : load(read(file), kindOf(file));
      if (!r.program || hasErrors(r.diagnostics)) {
        report(r.diagnostics, file, asJson);
        process.exit(1);
      }
      if (cmd === "ir") {
        const ir = r.program as unknown as Json;
        // Pretty output keeps the JCS member order so the file is the same whoever produced the IR.
        const jcs = canonicalize(ir);
        process.stdout.write(flags.has("--canonical") ? jcs : JSON.stringify(JSON.parse(jcs), null, 2) + "\n");
      } else if (cmd === "fmt") {
        process.stdout.write(printProgram(r.program));
      } else {
        const h = (r as ReturnType<typeof check>).hashes;
        if (!h) {
          report(r.diagnostics, file, asJson);
          process.exit(1);
        }
        process.stdout.write(JSON.stringify(h, null, 2) + "\n");
      }
      process.exit(0);
    }
    // falls through
    case "patch": {
      const [file, patchFile] = args;
      if (!file || !patchFile) usage();
      const loaded = load(read(file), kindOf(file));
      if (!loaded.program || hasErrors(loaded.diagnostics)) {
        report(loaded.diagnostics, file, asJson);
        process.exit(1);
      }
      const parsed = parseStrictJson(read(patchFile));
      if (!parsed.ok) {
        report(parsed.diagnostics, patchFile, asJson);
        process.exit(1);
      }
      const p = parsed.value.value as { base?: unknown; ops?: unknown };
      if (typeof p.base !== "string" || !Array.isArray(p.ops)) {
        process.stderr.write("mandate: patch file must be { \"base\": \"sha256:…\", \"ops\": [ … ] }\n");
        process.exit(2);
      }
      const r = applyPatch(loaded.program, p.base, p.ops as PatchOp[], modules);
      if (asJson) {
        report(r.diagnostics, file, true, { hash: r.hash ?? null, governance: r.governance, program: r.program ?? null });
      } else {
        report(r.diagnostics, file, false);
        if (r.ok) {
          for (const g of r.governance) process.stderr.write(`governance change: ${g.kind} at ${g.path}: ${g.detail}\n`);
          process.stdout.write(JSON.stringify(r.program, null, 2) + "\n");
        }
      }
      process.exit(r.ok ? 0 : 1);
    }
    // falls through
    case "sandbox": {
      const file = args[0] ?? usage();
      const lock = readLock(file, lockFile, asJson);
      const g = givenFor(library, lock);
      const r = check(read(file), kindOf(file), { modules, ...(lock ? { lock } : {}), ...givenOptions(g) });
      if (!r.ok) {
        report(r.diagnostics, file, asJson);
        process.exit(1);
      }
      const all = sandboxRequirements(r.program!, withModules(g, modules), lock);
      if (agent !== undefined && !Object.hasOwn(all, agent)) {
        process.stderr.write(`mandate: no local agent ${agent} in ${file}\n`);
        process.exit(2);
      }
      const out = agent !== undefined ? all[agent] : { program: r.hashes!.program, requirements: all };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      process.exit(0);
    }
    // falls through
    case "target": {
      if (args[0] !== "acs") usage();
      const file = args[1] ?? usage();
      const lock = readLock(file, lockFile, asJson);
      const g = givenFor(library, lock);
      const r = check(read(file), kindOf(file), { modules, ...(lock ? { lock } : {}), ...givenOptions(g) });
      if (!r.ok) {
        report(r.diagnostics, file, asJson);
        process.exit(1);
      }
      const t = acsTarget(r.program!, withModules(g, modules), lock);
      const dir = outDir ?? "acs";
      mkdirSync(dir, { recursive: true });
      for (const [name, a] of Object.entries(t.agents)) {
        mkdirSync(join(dir, name), { recursive: true });
        writeFileSync(join(dir, `${name}.manifest.json`), JSON.stringify(a.manifest, null, 2) + "\n");
        writeFileSync(join(dir, name, "policy.rego"), a.rego);
        writeFileSync(join(dir, `${name}.sandbox-requirement.json`), JSON.stringify(a.requirement, null, 2) + "\n");
      }
      const summary = { format: t.format, acs_version: t.acs_version, program: t.program, binding: t.binding, agents: Object.keys(t.agents), profile: t.profile };
      writeFileSync(join(dir, "profile.json"), JSON.stringify(summary, null, 2) + "\n");
      report(t.diagnostics, file, asJson, { ...summary, out: dir });
      if (!asJson) process.stdout.write(`wrote ${Object.keys(t.agents).length} agent(s) to ${dir}; hosts present ${t.binding} as envelope.agent.version\n`);
      process.exit(hasErrors(t.diagnostics) ? 1 : 0);
    }
    // falls through
    case "view": {
      const file = args[0] ?? usage();
      if (!["md", "html", "json"].includes(format)) usage();
      const loadChecked = (f: string, g: Given, lock?: Lock) => {
        const r = check(read(f), kindOf(f), { modules, ...(lock ? { lock } : {}), ...givenOptions(g) });
        if (!r.ok) {
          report(r.diagnostics, f, false);
          process.exit(1);
        }
        return r.program!;
      };
      const lock = readLock(file, lockFile, false);
      const g = givenFor(library, lock);
      const program = loadChecked(file, g, lock);
      // The modules a view is given: the caller's, and those of the libraries the lock pins (0.6).
      const linked = withModules(g, modules);
      if (flags.has("--card")) {
        if (against !== undefined) usage();
        // The card is of one workflow with an envelope: the only one, or the one --workflow names.
        const all = envelopeWorkflows(program);
        if (!all.length) {
          process.stderr.write(`mandate: ${file} has no workflow with an envelope, so it has no card\n`);
          process.exit(1);
        }
        if (workflow !== undefined ? !all.includes(workflow) : all.length > 1) {
          const why = workflow !== undefined ? `no workflow ${workflow} with an envelope in ${file}` : `${file} has several workflows with an envelope`;
          process.stderr.write(`mandate: ${why}; name one with --workflow: ${all.join(", ")}\n`);
          process.exit(2);
        }
        const name = workflow ?? all[0]!;
        // The libraries the command was given go to the card as they went to the check: a card of 0.7 is made from a check
        // that has them, and without them it is not made (the call throws, saying what is missing).
        const opts = { modules: linked, ...(lock ? { lock } : {}), ...(g.libraries.length ? { libraries: g.libraries } : {}) };
        let text: string;
        try {
          text = format === "json" ? JSON.stringify(card(program, name, opts), null, 2) + "\n" : format === "html" ? toHtml(cardDoc(program, name, opts)!) : toMarkdown(cardDoc(program, name, opts)!);
        } catch (e) {
          if (!(e instanceof Error) || e instanceof CompilerFailure) throw e;
          process.stderr.write(`mandate: ${file}: ${e.message}\n`);
          process.exit(1);
        }
        process.stdout.write(text);
      } else if (against !== undefined) {
        // The old version is checked without its lock, as before 0.6, but with the libraries that lock pins (0.6).
        const old = givenFor(library, peekLock(against, againstLock));
        const before = loadChecked(against, old);
        // The old version's lock, for who could decide before; none next to the old file is no lock, not an error.
        const beforeLock = readLock(against, againstLock, false);
        const locks = { ...(beforeLock ? { before: beforeLock } : {}), ...(lock ? { after: lock } : {}) };
        // 0.6: what a workflow that applies a pattern of a module commits, read from its expansion.
        const m = viewModules({ ...withModules(old, modules), ...linked }, before, program);
        const v = semanticDiff(before, program, locks, m);
        process.stdout.write(format === "json" ? JSON.stringify(v, null, 2) + "\n" : format === "html" ? toHtml(diffDoc(before, program, locks, m)) : toMarkdown(diffDoc(before, program, locks, m)));
      } else if (format === "json") {
        // 0.6: a workflow that applies a pattern of a module is shown as its expansion.
        const m = viewModules(linked, program);
        const views = { architecture: architecture(program, m, m ? lock : undefined), authority: authority(program, m), cost: cost(program, lock, m) };
        process.stdout.write(JSON.stringify(views, null, 2) + "\n");
      } else {
        // 0.6: the document of a program is given the modules too, as its views are; before 0.6, the program alone.
        const m = viewModules(linked, program);
        process.stdout.write(format === "html" ? toHtml(programDoc(program, lock, m)) : toMarkdown(programDoc(program, lock, m)));
      }
      process.exit(0);
    }
    // falls through
    case "mcp":
      void serveStdio(process.stdin, process.stdout, modules).then(() => process.exit(0));
      return;
    case "explain": {
      const raw = args[0] ?? usage();
      const code = raw.startsWith("MDT-") ? raw : `MDT-${raw}`;
      const entry = CODES[code];
      if (!entry) {
        process.stderr.write(`mandate: unknown code ${raw}\n`);
        process.exit(2);
      }
      if (asJson) process.stdout.write(JSON.stringify({ code, ...entry }, null, 2) + "\n");
      else process.stdout.write(`${code} ${entry.title}\n\n${entry.explain}\n`);
      process.exit(0);
    }
    // falls through
    case "add":
    case "upgrade":
    case "publish":
      process.exit(
        libraryCommand(cmd, library, io, () => {
          process.stderr.write(usageText());
          return new Stop(2);
        }),
      );
    // falls through
    default:
      usage();
  }
}

const CONTROL = new Set(["run", "status", "approve", "decline", "answer", "cancel", "reconcile", "shadow-diff", "raise-limits", "replay", "artifact", "show", "denials", "rotate-key", "test", "onboard", "drift", "deploy", "key", "decision", "verify-decision", "approve-envelope", "amend", "journal", "egress", "halt", "otel", "connector", "review", "tick", "promote"]);

/** Control commands belong to the runtime, which depends on the compiler; it is loaded only when asked for. */
async function control(argv: string[]): Promise<void> {
  const specifier: string = "@mandate/runtime/cli";
  let runtime: { main(argv: string[]): Promise<number> };
  try {
    runtime = (await import(specifier)) as typeof runtime;
  } catch (e) {
    process.stderr.write(`mandate: ${argv[0]} needs @mandate/runtime (built): ${(e as Error).message}\n`);
    process.exit(2);
  }
  process.exit(await runtime.main(argv));
}

/**
 * A failure of the compiler behind the bridge (its module missing, trapping, out of memory, or answering what is
 * not an answer) is the command's failure, never a program that checks: exit status 2, with what failed.
 */
function failed(e: unknown): never {
  if (!(e instanceof CompilerFailure)) throw e;
  process.stderr.write(`mandate: ${e.message}\n`);
  process.exit(2);
}

const argv = process.argv.slice(2);
if (CONTROL.has(argv[0] ?? "")) void control(argv).catch(failed);
else {
  try {
    main(argv);
  } catch (e) {
    failed(e);
  }
}
