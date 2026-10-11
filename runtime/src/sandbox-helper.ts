// The runtime's file tools inside a Windows sandbox (P2-27). On Linux the
// tools are processes of the base system (cat, ls, grep, sh); a Windows
// AppContainer has no such programs, so the host runs this script with the
// node.exe it already allows, under the same policy. It behaves like the
// Linux tools it stands for, so the agent sees the same results:
//
//   cat <path>                  the file's bytes                     (cat -- path)
//   ls <path>                   one entry per line, dirs end in "/"  (ls -1Ap -- path)
//   grep <pattern> <path> [skip…] path:line:text, recursive, not into directories named skip; exit 1 when nothing matches
//   write <staged> <target>     copies a staged file to target, making directories
//
// The script is plain JavaScript, written by the host to a directory of its
// own as an .mjs file. Node then needs nothing else to run it: no package.json
// next to it, no TypeScript, no parent directory the policy does not grant.
// It reads and writes only what the sandbox's policy lets this process reach.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HELPER_SOURCE = String.raw`import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const [op, ...args] = process.argv.slice(2);
const slash = (p) => p.replace(/\\/g, "/");

function fail(code, message) {
  process.stderr.write(message + "\n");
  process.exit(code);
}

function reason(e) {
  const code = e && e.code;
  return code === "ENOENT" ? "No such file or directory" : code === "EPERM" || code === "EACCES" ? "Permission denied" : String(e && e.message);
}

if (op === "cat") {
  const p = args[0] || "";
  try {
    process.stdout.write(readFileSync(p));
  } catch (e) {
    fail(1, "cat: " + p + ": " + reason(e));
  }
} else if (op === "ls") {
  const p = args[0] || "";
  try {
    const entries = readdirSync(p, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name));
    process.stdout.write(entries.sort().map((n) => n + "\n").join(""));
  } catch (e) {
    fail(2, "ls: cannot access '" + p + "': " + reason(e));
  }
} else if (op === "grep") {
  const pattern = args[0] || "";
  const root = args[1] || "";
  const skip = new Set(args.slice(2));
  let re;
  try {
    re = new RegExp(pattern);
  } catch (e) {
    fail(2, "grep: " + e.message);
  }
  const hits = [];
  const visit = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch (e) {
      fail(2, "grep: " + p + ": " + reason(e));
    }
    if (st.isDirectory()) {
      for (const name of readdirSync(p).sort()) if (!skip.has(name)) visit(join(p, name));
      return;
    }
    const bytes = readFileSync(p);
    if (bytes.includes(0)) return;
    bytes
      .toString("utf8")
      .split(/\r?\n/)
      .forEach((line, i) => {
        if (re.test(line)) hits.push(slash(p) + ":" + (i + 1) + ":" + line);
      });
  };
  visit(root);
  if (!hits.length) process.exit(1);
  process.stdout.write(hits.map((h) => h + "\n").join(""));
} else if (op === "write") {
  const staged = args[0] || "";
  const target = args[1] || "";
  try {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(staged, target);
  } catch (e) {
    fail(1, "write_file: cannot create " + target + ": " + reason(e));
  }
} else {
  fail(2, "sandbox-helper: unknown operation " + (op || ""));
}
`;

let written: string | undefined;

/** The helper as a file, written once per process to a directory of its own, which sandboxes may read. */
export function helperFile(): string {
  if (!written) {
    const dir = mkdtempSync(join(tmpdir(), "mandate-helper-"));
    written = join(dir, "sandbox-helper.mjs");
    writeFileSync(written, HELPER_SOURCE);
  }
  return written;
}
