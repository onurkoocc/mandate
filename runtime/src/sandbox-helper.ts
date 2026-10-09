// The runtime's file tools inside a Windows sandbox (P2-27). On Linux the
// tools are processes of the base system (cat, ls, grep, sh); a Windows
// AppContainer has no such programs, so the host runs this script with the
// node.exe it already allows, under the same policy. It behaves like the
// Linux tools it stands for, so the agent sees the same results:
//
//   cat <path>                  the file's bytes                     (cat -- path)
//   ls <path>                   one entry per line, dirs end in "/"  (ls -1Ap -- path)
//   grep <pattern> <path>       path:line:text, recursive; exit 1 when nothing matches
//   write <staged> <target>     copies a staged file to target, making directories
//
// It reads and writes only what the sandbox's policy lets this process reach.
// It imports nothing outside Node, and holds no state.

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

const [op, ...args] = process.argv.slice(2);
const slash = (p: string): string => p.replace(/\\/g, "/");

function fail(code: number, message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function reason(e: unknown): string {
  const code = (e as { code?: string }).code;
  return code === "ENOENT" ? "No such file or directory" : code === "EPERM" || code === "EACCES" ? "Permission denied" : String((e as Error).message);
}

switch (op) {
  case "cat": {
    const p = args[0] ?? "";
    try {
      process.stdout.write(readFileSync(p));
    } catch (e) {
      fail(1, `cat: ${p}: ${reason(e)}`);
    }
    break;
  }
  case "ls": {
    const p = args[0] ?? "";
    try {
      const entries = readdirSync(p, { withFileTypes: true }).map((d) => (d.isDirectory() ? `${d.name}/` : d.name));
      process.stdout.write(entries.sort().map((n) => `${n}\n`).join(""));
    } catch (e) {
      fail(2, `ls: cannot access '${p}': ${reason(e)}`);
    }
    break;
  }
  case "grep": {
    const [pattern = "", root = ""] = args;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (e) {
      fail(2, `grep: ${(e as Error).message}`);
    }
    const hits: string[] = [];
    const visit = (p: string): void => {
      let st;
      try {
        st = statSync(p);
      } catch (e) {
        fail(2, `grep: ${p}: ${reason(e)}`);
      }
      if (st.isDirectory()) {
        for (const name of readdirSync(p).sort()) visit(join(p, name));
        return;
      }
      const bytes = readFileSync(p);
      if (bytes.includes(0)) return; // binary, as grep -I skips it
      bytes
        .toString("utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (re.test(line)) hits.push(`${slash(p)}:${i + 1}:${line}`);
        });
    };
    visit(root);
    if (!hits.length) process.exit(1);
    process.stdout.write(hits.map((h) => `${h}\n`).join(""));
    break;
  }
  case "write": {
    const [staged = "", target = ""] = args;
    try {
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(staged, target);
    } catch (e) {
      fail(1, `write_file: cannot create ${target}: ${reason(e)}`);
    }
    break;
  }
  default:
    fail(2, `sandbox-helper: unknown operation ${op ?? ""}`);
}
