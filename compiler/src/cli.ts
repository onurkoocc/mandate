#!/usr/bin/env node
// mandate — command-line front end for the 0.1 reference compiler.
//
//   mandate check <file> [--json]          validate, resolve names, print hashes
//   mandate ir <file> [--canonical]        print canonical IR (pretty, or the exact JCS bytes)
//   mandate fmt <file>                     print the .mdt projection of the IR
//   mandate hash <file>                    print program and definition hashes
//   mandate patch <program> <patch.json>   apply an IR patch (see `patch` below)
//   mandate explain <code>                 explain a diagnostic code
//
// <file> is .mdt text or .json canonical IR. Exit status is 1 when any error
// diagnostic is reported, 2 on usage errors.

import { readFileSync } from "node:fs";
import { check, kindOf, load } from "./check.js";
import { CODES } from "./codes.js";
import { formatDiagnostic, hasErrors, type Diagnostic } from "./diag.js";
import { canonicalize } from "./json/jcs.js";
import type { Json } from "./json/strict-json.js";
import { parseStrictJson } from "./json/strict-json.js";
import { applyPatch, type PatchOp } from "./patch/patch.js";
import { printProgram } from "./print/printer.js";

function usage(): never {
  process.stderr.write(
    [
      "usage: mandate <command> [options]",
      "  check <file> [--json]",
      "  ir <file> [--canonical]",
      "  fmt <file>",
      "  hash <file>",
      "  patch <program> <patch.json> [--json]   patch.json: { \"base\": \"sha256:…\", \"ops\": [ … ] }",
      "  explain <code>",
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

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const flags = new Set(rest.filter((a) => a.startsWith("--")));
  const args = rest.filter((a) => !a.startsWith("--"));
  const asJson = flags.has("--json");

  switch (cmd) {
    case "check": {
      const file = args[0] ?? usage();
      const r = check(read(file), kindOf(file));
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

main(process.argv.slice(2));
