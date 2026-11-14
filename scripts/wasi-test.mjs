#!/usr/bin/env node
// Builds Rust test executables for wasm32-wasip1 and runs them under Node's
// built-in `node:wasi`, so that no native executable is built or started.
//
//   node scripts/wasi-test.mjs [cargo test arguments] [-- libtest arguments]
//
//   node scripts/wasi-test.mjs -p mandate-ir
//   node scripts/wasi-test.mjs -p mandate-ir --test conformance -- --nocapture
//   node scripts/wasi-test.mjs -p mandate-ir -- reader --exact
//
// It runs `cargo test --locked --target wasm32-wasip1 --no-run
// --message-format=json` with the arguments before `--`, takes the test
// executables from the `compiler-artifact` messages, and runs each one with
// the arguments after `--` (libtest filters and flags such as `--nocapture`
// work). The exit code is 0 when every executable exited with 0, else the
// first non-zero exit code (101 when the program trapped). It runs from any
// directory; the repository root is found from this file's place.
//
// Why a driver and not a cargo runner (`[target.wasm32-wasip1] runner` in
// `.cargo/config.toml`): cargo starts a test executable with the package's
// directory as the working directory, and resolves only the runner's program
// path, not its arguments, against the config file; a runner of
// `node scripts/wasi-test.mjs` would find no script. Here the script locates
// itself, and nothing in `.cargo/` can change what a native `cargo test` does.
//
// The repository root is preopened as `/repo` and the environment variable
// MANDATE_REPO=/repo is set in the WASI environment; the tests read it (and
// MANDATE_GOLDEN_OUT, when set on the host, as a path inside the repository). Node
// cannot preopen a directory read-only, so "read-only" is a convention of the
// tests, which only read. Needs: the target (`rust-toolchain.toml` lists it,
// `rustup toolchain install` installs it), cargo on PATH, and Node 22 or later.
// Node may print a warning that WASI is experimental; that is not suppressed.
//
// Limits of this target:
// - A panic aborts the process (no unwinding): the first failing test ends the
//   executable, with the panic message on stderr and no `test result: FAILED`
//   line. The driver reports "trapped" and exits with 101.
// - `#[should_panic]` tests cannot pass, since the panic cannot be caught.
// - Tests run on one thread, one after the other.
// - A test that starts a process (std::process::Command) cannot run: WASI
//   preview 1 has no processes. Neither can the CARGO_BIN_EXE_* tests.
// - Doc tests are not run (cargo does not run them for another target).
// - The file system is the preopened repository only; no network.
// - usize is 32 bits. One assertion of mandate-ir's tests/api.rs, that
//   usize::MAX saturates to the largest Int, is compiled only for 64-bit targets.
// - Node's WASI has no directory listing on Windows (fd_readdir answers
//   ENOSYS), so `std::fs::read_dir` would fail there; `withReaddir` below
//   supplies one, used only when Node answers ENOSYS.
// A test that hits a limit is left out of the WASM run by being outside
// `-p mandate-ir`, or by a filter after `--` (`--skip name`); no `mandate-ir`
// test needed that.

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeSync } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';

const TARGET = 'wasm32-wasip1';
const root = fileURLToPath(new URL('..', import.meta.url));

/** Writes to stdout at once, in order with what the WASI program writes. */
function say(text) {
  writeSync(1, `${text}\n`);
}

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const cargoArgs = split === -1 ? argv : argv.slice(0, split);
const libtestArgs = split === -1 ? [] : argv.slice(split + 1);

// 1. Build the test executables.
const build = spawnSync(
  process.env.CARGO ?? 'cargo',
  ['test', '--locked', '--target', TARGET, '--no-run', '--message-format=json', ...cargoArgs],
  { cwd: root, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 1 << 28 },
);
if (build.error) {
  say(`cannot run cargo: ${build.error.message}`);
  process.exit(1);
}

const executables = [];
for (const line of build.stdout.split('\n')) {
  if (!line.startsWith('{')) continue;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    continue;
  }
  if (message.reason === 'compiler-artifact' && message.profile?.test && message.executable) {
    executables.push({ name: `${message.target.name} (${message.target.kind.join(',')})`, path: message.executable });
  } else if (message.reason === 'compiler-message' && message.message?.rendered) {
    process.stderr.write(message.message.rendered);
  }
}
if (build.status !== 0) {
  say(`cargo test --no-run failed with exit code ${build.status}`);
  process.exit(build.status ?? 1);
}
if (executables.length === 0) {
  say('cargo built no test executable for the arguments given');
  process.exit(1);
}
executables.sort((a, b) => a.name.localeCompare(b.name));

// Node's WASI has no `fd_readdir` on Windows: it answers ENOSYS ("Function not
// implemented"), so `std::fs::read_dir` fails there. `withReaddir` adds one. It
// only answers when Node itself says ENOSYS, so on Linux, where Node has the
// call, it is never used. It needs to know which host directory a descriptor is,
// so it also watches `path_open` and `fd_close`.
const ENOSYS = 52;
const FILETYPE = { directory: 3, file: 4, symlink: 7 };

function withReaddir(imports, hostRoot) {
  const wasi = imports.wasi_snapshot_preview1;
  const hostPaths = new Map([[3, hostRoot]]); // descriptor 3 is the first preopen, /repo
  let memory;
  const view = () => new DataView(memory.buffer);
  return {
    setMemory(m) {
      memory = m;
    },
    imports: {
      ...imports,
      wasi_snapshot_preview1: {
        ...wasi,
        path_open(dirfd, dirflags, pathPtr, pathLen, ...rest) {
          const errno = wasi.path_open(dirfd, dirflags, pathPtr, pathLen, ...rest);
          const parent = hostPaths.get(dirfd);
          if (errno === 0 && parent !== undefined) {
            const relative = Buffer.from(memory.buffer, pathPtr, pathLen).toString('utf8');
            hostPaths.set(view().getUint32(rest[rest.length - 1], true), resolve(parent, ...relative.split('/')));
          }
          return errno;
        },
        fd_close(fd) {
          if (fd !== 3) hostPaths.delete(fd);
          return wasi.fd_close(fd);
        },
        fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr) {
          const errno = wasi.fd_readdir(fd, bufPtr, bufLen, cookie, usedPtr);
          const host = hostPaths.get(fd);
          if (errno !== ENOSYS || host === undefined) return errno;
          let entries;
          try {
            entries = readdirSync(host, { withFileTypes: true });
          } catch {
            return 29; // EIO
          }
          // A dirent is 24 bytes (d_next u64, d_ino u64, d_namlen u32, d_type u8, padding) and the name.
          const chunks = [];
          let total = 0;
          for (let i = Number(cookie); i < entries.length && total < bufLen; i++) {
            const name = Buffer.from(entries[i].name, 'utf8');
            const head = Buffer.alloc(24);
            head.writeBigUInt64LE(BigInt(i + 1), 0);
            head.writeUInt32LE(name.length, 16);
            head.writeUInt8(entries[i].isDirectory() ? FILETYPE.directory : entries[i].isSymbolicLink() ? FILETYPE.symlink : FILETYPE.file, 20);
            chunks.push(head, name);
            total += 24 + name.length;
          }
          const bytes = Buffer.concat(chunks).subarray(0, bufLen); // a last entry may be cut; the caller asks again
          new Uint8Array(memory.buffer, bufPtr, bytes.length).set(bytes);
          view().setUint32(usedPtr, bytes.length, true);
          return 0;
        },
      },
    },
  };
}

// MANDATE_GOLDEN_OUT (the golden gate writes its output texts there, for a
// comparison with the TypeScript compiler's) is passed on as the same directory
// seen from inside the guest: it must lie inside the repository, the only
// directory the guest can write to.
const guestEnv = { MANDATE_REPO: '/repo' };
if (process.env.MANDATE_GOLDEN_OUT) {
  const inside = relative(root, resolve(process.env.MANDATE_GOLDEN_OUT));
  if (inside === '' || inside.startsWith('..') || resolve(inside) === inside || /^[A-Za-z]:/.test(inside)) {
    say('MANDATE_GOLDEN_OUT must name a directory inside the repository under WASI');
    process.exit(1);
  }
  guestEnv.MANDATE_GOLDEN_OUT = '/repo/' + inside.split(sep).join('/');
}

// 2. Run each one under WASI.
let exitCode = 0;
for (const { name, path } of executables) {
  say(`\n     Running ${name} under node:wasi\n               ${path}`);
  const wasi = new WASI({
    version: 'preview1',
    args: [basename(path), ...libtestArgs],
    env: guestEnv,
    preopens: { '/repo': root },
    returnOnExit: true,
  });
  let code;
  try {
    const module = await WebAssembly.compile(readFileSync(path));
    const hooks = withReaddir(wasi.getImportObject(), root);
    const instance = await WebAssembly.instantiate(module, hooks.imports);
    hooks.setMemory(instance.exports.memory);
    code = wasi.start(instance);
  } catch (error) {
    say(`${name} trapped: ${error instanceof Error ? error.message : error}`);
    code = 101;
  }
  if (code !== 0) {
    say(`${name} exited with code ${code}`);
    if (exitCode === 0) exitCode = code;
  }
}
say(exitCode === 0 ? `\nall ${executables.length} test executables exited with 0` : '\nFAILED');
process.exit(exitCode);
