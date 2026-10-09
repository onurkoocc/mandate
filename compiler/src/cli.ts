#!/usr/bin/env node
// mandate — command-line front end for the 0.1 reference compiler.
//
//   mandate check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]…
//                                          validate, resolve names, print hashes
//   mandate ir <file> [--canonical]        print canonical IR (pretty, or the exact JCS bytes)
//   mandate fmt <file>                     print the .mdt projection of the IR
//   mandate hash <file>                    print program and definition hashes
//   mandate patch <program> <patch.json>   apply an IR patch (see `patch` below)
//   mandate sandbox <file> [--agent <name>] print each agent's sandbox requirement
//   mandate explain <code>                 explain a diagnostic code
//   mandate mcp                            serve check, explain, apply_patch and views to agents
//                                          over MCP on stdio (§14)
//   mandate view <file> [--against <old>] [--format md|html|json] [--lock <lock.json>]
//                                          the program's human views (§15): architecture,
//                                          authority and cost; with --against, what changed
//
//   mandate run | status | approve | decline | answer | cancel | raise-limits | replay | artifact | show | denials | rotate-key
//                                          control a run (the runtime's CLI, @mandate/runtime/cli)
//   mandate test <file>                    run the program's tests with their effect handlers (§6.4)
//
// <file> is .mdt text or .json canonical IR. `--module <file>` (repeatable)
// loads a module the program imports, such as a system model (design doc 9
// §2.1); `check`, `sandbox` and `view` link it in. `check` and `sandbox` read the
// lock file named by --lock, or else mandate.lock.json next to <file> if there
// is one. Exit status is 1 when any error diagnostic is reported, 2 on usage
// errors.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, kindOf, load, loadModules } from "./check.js";
import { CODES } from "./codes.js";
import { formatDiagnostic, hasErrors, type Diagnostic } from "./diag.js";
import { canonicalize } from "./json/jcs.js";
import type { Json } from "./json/strict-json.js";
import { parseStrictJson } from "./json/strict-json.js";
import type { Lock } from "./lock.js";
import { linkedProgram, type Modules } from "./modules.js";
import { applyPatch, type PatchOp } from "./patch/patch.js";
import { printProgram } from "./print/printer.js";
import { serveStdio } from "./mcp/server.js";
import { denialDiagnostics, sandboxRequirements, type DenialReport } from "./target/sandbox.js";
import { toHtml, toMarkdown } from "./views/doc.js";
import { architecture, authority, cost, diffDoc, hasSystem, programDoc, semanticDiff, system } from "./views/views.js";

function usage(): never {
  process.stderr.write(
    [
      "usage: mandate <command> [options]",
      "  check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]…",
      "  ir <file> [--canonical]",
      "  fmt <file>",
      "  hash <file>",
      "  patch <program> <patch.json> [--json]   patch.json: { \"base\": \"sha256:…\", \"ops\": [ … ] }",
      "  sandbox <file> [--agent <name>] [--lock <lock.json>] [--module <file>]…",
      "  explain <code>",
      "  view <file> [--against <old file>] [--format md|html|json] [--lock <lock.json>] [--module <file>]…",
      "  mcp   (an MCP server on stdio)",
      "  run | status | approve | decline | answer | cancel | raise-limits | replay | artifact | show | denials | rotate-key   (see `mandate status`)",
      "  test <file> [--json]",
      "",
    ].join("\n"),
  );
  process.exit(2);
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
  const against = option(plain, "--against");
  const denials = option(plain, "--denials");
  const format = option(plain, "--format") ?? "md";
  const flags = new Set(plain.filter((a) => a.startsWith("--")));
  const args = plain.filter((a) => !a.startsWith("--"));
  const asJson = flags.has("--json");
  const modules = readModules(moduleFiles, asJson);

  switch (cmd) {
    case "check": {
      const file = args[0] ?? usage();
      const lock = readLock(file, lockFile, asJson);
      const r = check(read(file), kindOf(file), { modules, ...(lock ? { lock } : {}) });
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
      const r = applyPatch(loaded.program, p.base, p.ops as PatchOp[]);
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
      const r = check(read(file), kindOf(file), { modules, ...(lock ? { lock } : {}) });
      if (!r.ok) {
        report(r.diagnostics, file, asJson);
        process.exit(1);
      }
      const all = sandboxRequirements(r.program!, modules);
      if (agent !== undefined && !Object.hasOwn(all, agent)) {
        process.stderr.write(`mandate: no local agent ${agent} in ${file}\n`);
        process.exit(2);
      }
      const out = agent !== undefined ? all[agent] : { program: r.hashes!.program, requirements: all };
      process.stdout.write(JSON.stringify(out, null, 2) + "\n");
      process.exit(0);
    }
    // falls through
    case "view": {
      const file = args[0] ?? usage();
      if (!["md", "html", "json"].includes(format)) usage();
      const loadChecked = (f: string, lock?: Lock) => {
        const r = check(read(f), kindOf(f), { modules, ...(lock ? { lock } : {}) });
        if (!r.ok) {
          report(r.diagnostics, f, false);
          process.exit(1);
        }
        return r.program!;
      };
      const lock = readLock(file, lockFile, false);
      const program = loadChecked(file, lock);
      if (against !== undefined) {
        const before = loadChecked(against);
        const v = semanticDiff(before, program);
        process.stdout.write(format === "json" ? JSON.stringify(v, null, 2) + "\n" : format === "html" ? toHtml(diffDoc(before, program)) : toMarkdown(diffDoc(before, program)));
      } else if (format === "json") {
        const views = { architecture: architecture(program), authority: authority(program), cost: cost(program, lock) };
        process.stdout.write(JSON.stringify(views, null, 2) + "\n");
      } else {
        process.stdout.write(format === "html" ? toHtml(programDoc(program, lock)) : toMarkdown(programDoc(program, lock)));
      }
      process.exit(0);
    }
    // falls through
    case "mcp":
      void serveStdio().then(() => process.exit(0));
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
    default:
      usage();
  }
}

const CONTROL = new Set(["run", "status", "approve", "decline", "answer", "cancel", "reconcile", "shadow-diff", "raise-limits", "replay", "artifact", "show", "denials", "rotate-key", "test"]);

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

const argv = process.argv.slice(2);
if (CONTROL.has(argv[0] ?? "")) void control(argv);
else main(argv);
