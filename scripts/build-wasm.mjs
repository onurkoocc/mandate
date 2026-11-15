#!/usr/bin/env node
// Builds the Rust compiler as the WebAssembly module the bridge runs (bridge/src/wasm/), and puts it in the bridge's
// own place with its digest:
//
//   npm run build:wasm
//
// It runs cargo with the memory ceiling and the stack fixed at link time (at most 256 MiB of memory, a 4 MiB stack
// first in memory; CI's rust job runs the same command), copies target/wasm32-wasip1/release/mandate-wasm.wasm to
// bridge/wasm/mandate-wasm.wasm, and writes beside it bridge/wasm/mandate-wasm.digest.json, its SHA-256 and its
// length, which the bridge checks before it takes the module from there. Neither file is committed
// (bridge/.gitignore). No dependency: Node's own modules and cargo.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = [
  "rustc",
  "--locked",
  "-p",
  "mandate-wasm",
  "--release",
  "--target",
  "wasm32-wasip1",
  "--bin",
  "mandate-wasm",
  "--",
  "-C",
  "link-arg=--max-memory=268435456",
  "-C",
  "link-arg=-zstack-size=4194304",
  "-C",
  "link-arg=--stack-first",
];
const built = spawnSync("cargo", args, { cwd: root, stdio: "inherit" });
if (built.error) {
  process.stderr.write(`build:wasm: cargo could not be run (${built.error.message}); install the toolchain rust-toolchain.toml pins\n`);
  process.exit(1);
}
if (built.status !== 0) process.exit(built.status ?? 1);

const from = join(root, "target", "wasm32-wasip1", "release", "mandate-wasm.wasm");
const dir = join(root, "bridge", "wasm");
const to = join(dir, "mandate-wasm.wasm");
const digestFile = join(dir, "mandate-wasm.digest.json");
mkdirSync(dir, { recursive: true });
// The module and then its digest, each written whole and renamed into place, so that a reader never sees a module
// with another's digest beside it for longer than between the two renames (and then refuses it).
copyFileSync(from, `${to}.tmp`);
renameSync(`${to}.tmp`, to);
const bytes = readFileSync(to);
const digest = { format: "mandate/wasm-digest/0.1", sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`, bytes: bytes.length };
writeFileSync(`${digestFile}.tmp`, `${JSON.stringify(digest, null, 2)}\n`);
renameSync(`${digestFile}.tmp`, digestFile);
process.stdout.write(`build:wasm: ${to} (${bytes.length} bytes, ${digest.sha256})\n`);
