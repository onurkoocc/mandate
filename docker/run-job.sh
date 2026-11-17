#!/bin/bash
# The steps of the jobs of .github/workflows/ci.yml, run in the job container on the clone of the commit under test:
#
#   run-job.sh <job> <full commit sha> [command...]
#
# docker/boot.sh (fixed, in the image) has made the clone in /ci/repo from the archive of the commit and runs this file
# from it: the steps travel with the commit they test. A commit from before docker/ existed has none, and boot.sh then
# runs the copy that is baked into the image. For the job of the given name the steps are those of the job of the same
# name in ci.yml, in the same order; docker/check.mjs fails when a step of ci.yml is neither here nor in its list of
# known differences. What differs from CI is said where it differs: $RUNNER_TEMP is a temporary directory, the tools
# that CI installs are in the image (Node, OPA, the Rust toolchain), PostgreSQL and the OpenTelemetry Collector are
# compose services (the script starts them), and what needs a real Docker engine or Windows is not run
# (docker/README.md).
#
# Bash without -o pipefail, as GitHub runs a `run:` block by default (bash -e).
set -eu

job="${1:?usage: run-job.sh <job> <sha> [command...]}"
sha="${2:?usage: run-job.sh <job> <sha> [command...]}"
shift 2

started="$(date +%s)"
step() { echo; echo "=== [+$(($(date +%s) - started)) s] $*"; }

use_node() { # 22 or 24
  case "$1" in
    22) export PATH="$NODE22_HOME/bin:$PATH" ;;
    24) export PATH="$NODE24_HOME/bin:$PATH" ;;
    *) echo "unknown node $1"; exit 2 ;;
  esac
  echo "node $(node --version), npm $(npm --version)"
}

export RUNNER_TEMP
RUNNER_TEMP="$(mktemp -d)"

cd /ci/repo

job_rust() {
  use_node 24
  step "Install the pinned Rust toolchain"
  rustup toolchain install
  step "cargo fmt --check"
  cargo fmt --check
  step "cargo clippy --all-targets --locked -- -D warnings"
  cargo clippy --all-targets --locked -- -D warnings
  # --nocapture so that the log shows how many conformance cases the crates ran and skipped.
  step "Rust tests, against the vectors the TypeScript compiler writes and the conformance cases"
  cargo test --locked -- --nocapture
  # ci.yml runs docker/check.mjs here, after setup-node. A commit from before docker/ existed has none.
  step "The Docker environment is what the workflows pin (docker/check.mjs)"
  if [ -f docker/check.mjs ]; then
    node docker/check.mjs
  else
    echo "skipped: this commit has no docker/check.mjs"
  fi
  step "npm ci --ignore-scripts"
  npm ci --ignore-scripts
  step "npm run build"
  npm run build
  # The runtime that makes the run below loads the bridge, which answers with the Rust compiler's module.
  step "Build the Rust compiler's WebAssembly module"
  npm run build:wasm
  step "Build verify-journal"
  cargo build --locked -p verify-journal
  step "verify-journal verifies a fresh export of a real run, and finds one event changed"
  fresh="$RUNNER_TEMP/fresh"
  node runtime/scripts/journal-fresh.mjs "$fresh"
  verify() { cargo run --locked --quiet -p verify-journal -- "$@"; }

  code=0
  verify "$fresh/export.json" --key "$fresh/key.pem" > "$fresh/rust-report.json" || code=$?
  cat "$fresh/rust-report.json"
  if [ "$code" -ne 0 ]; then echo "::error::the fresh export: exit $code, not 0"; exit 1; fi
  grep -q '^  "status": "verified",$' "$fresh/rust-report.json"
  cmp "$fresh/report.json" "$fresh/rust-report.json"

  code=0
  verify "$fresh/tampered.json" --key "$fresh/key.pem" > "$fresh/rust-tampered.json" || code=$?
  cat "$fresh/rust-tampered.json"
  if [ "$code" -ne 1 ]; then echo "::error::the tampered export: exit $code, not 1"; exit 1; fi
  seq="$(cat "$fresh/tampered-seq")"
  grep -A1 '"code": "chain_broken",' "$fresh/rust-tampered.json" | grep -q "\"seq\": $seq\$"
  cmp "$fresh/tampered-report.json" "$fresh/rust-tampered.json"

  step "The test data of the Rust crates is what the TypeScript compiler gives now"
  for script in scripts/*-vectors.mjs; do
    echo "--- $script"
    node "$script"
    changed="$(git status --porcelain)"
    if [ -n "$changed" ]; then
      echo "::error::$script changed or wrote files that are not committed:"
      echo "$changed"
      git diff
      exit 1
    fi
  done

  step "Build the crates for WebAssembly"
  packages=""
  for manifest in crates/*/Cargo.toml; do
    crate="$(sed -n 's/^name = "\(.*\)"$/\1/p' "$manifest" | head -n 1)"
    if [ -z "$crate" ]; then echo "::error::$manifest has no package name"; exit 1; fi
    case "$crate" in
      verify-journal | mandate-cli) ;;
      *) packages="$packages -p $crate" ;;
    esac
  done
  echo "building:$packages"
  cargo build --locked --target wasm32-wasip1 $packages

  step "Tests of the crates under Node's WASI"
  failed=""
  for manifest in crates/*/Cargo.toml; do
    crate="$(sed -n 's/^name = "\(.*\)"$/\1/p' "$manifest" | head -n 1)"
    if [ -z "$crate" ]; then echo "::error::$manifest has no package name"; exit 1; fi
    case "$crate" in
      verify-journal | mandate-cli)
        echo "--- $crate: not run under WASI (it starts processes or reads files)"
        continue
        ;;
    esac
    echo "::group::$crate under Node's WASI"
    if ! node scripts/wasi-test.mjs -p "$crate" -- --nocapture; then
      echo "::endgroup::"
      echo "::error::the tests of $crate failed under Node's WASI"
      failed="$failed $crate"
    else
      echo "::endgroup::"
    fi
  done
  if [ -n "$failed" ]; then echo "::error::failed under Node's WASI:$failed"; exit 1; fi

  step "Build the WebAssembly module of the compiler (mandate-wasm)"
  cargo rustc --locked -p mandate-wasm --release --target wasm32-wasip1 --bin mandate-wasm -- \
    -C link-arg=--max-memory=268435456 -C link-arg=-zstack-size=4194304 -C link-arg=--stack-first
  ls -l target/wasm32-wasip1/release/mandate-wasm.wasm
}

job_parity() {
  use_node 24
  step "Install the pinned Rust toolchain"
  rustup toolchain install
  step "npm ci --ignore-scripts"
  npm ci --ignore-scripts
  step "npm run build"
  npm run build
  step "The TypeScript compiler writes its output texts"
  (cd compiler && MANDATE_GOLDEN_OUT="$RUNNER_TEMP/parity/ts" npx vitest run test/golden.test.ts)
  step "The Rust compiler writes its output texts"
  MANDATE_GOLDEN_OUT="$RUNNER_TEMP/parity/rust" cargo test --locked -p mandate-testkit --test golden -- --nocapture
  step "The two directories hold the same files and the same bytes"
  PARITY="$RUNNER_TEMP/parity"
  want="$(node -e 'const g = JSON.parse(require("fs").readFileSync("compiler/test/golden/outputs.json", "utf8")); console.log(Object.values(g).reduce((n, row) => n + Object.keys(row).length, 0))')"
  echo "the golden file pins $want outputs"
  # The outputs of 0.1 to 0.5 are 231: the golden file may grow, and may not shrink.
  if [ "$want" -lt 231 ]; then echo "::error::the golden file pins $want outputs, fewer than the 231 of releases 0.1 to 0.5: an output was removed"; exit 1; fi
  for side in ts rust; do
    have="$(find "$PARITY/$side" -type f | wc -l)"
    echo "$side: $have files"
    if [ "$have" -ne "$want" ]; then echo "::error::$side wrote $have files, not $want"; exit 1; fi
  done
  diff -ru "$PARITY/ts" "$PARITY/rust"
  echo "the $want output texts are the same"
}

job_test() {
  use_node 22
  step "npm ci --ignore-scripts"
  npm ci --ignore-scripts
  step "npm run typecheck"
  npm run typecheck
  step "npm run build"
  npm run build
  step "Install the pinned Rust toolchain"
  rustup toolchain install
  step "Build the Rust compiler's WebAssembly module"
  npm run build:wasm
  step "npm test"
  npm test
  step "The compiled corpus holds every call the compiler's tests make to a front door"
  MANDATE_CORPUS=1 npm test -w compiler
  # In ci.yml the server is on localhost with a password; here it is the compose service, on the private network of the
  # project, with trust authentication (no password).
  step "Runtime tests on PostgreSQL"
  MANDATE_TEST_DATABASE_URL=postgresql://mandate@postgres:5432/mandate_test npm test -w runtime
  step "Check the FixBug fixture with the CLI"
  node bridge/dist/cli.js check fixtures/fixbug/fixbug.mdt
  node bridge/dist/cli.js check fixtures/fixbug/fixbug.ir.json
  node bridge/dist/cli.js sandbox fixtures/fixbug/fixbug.ir.json > /dev/null
  node bridge/dist/cli.js test fixtures/fixbug/fixbug.mdt
  # ci.yml downloads OPA here and checks its sha256; the image holds the same binary, checked when it was built.
  step "OPA 1.4.2 (from the image, sha256 checked at build)"
  MANDATE_OPA="$(command -v opa)"
  "$MANDATE_OPA" version
  step "The generated Rego on a real OPA (X05), run and not skipped"
  (
    cd compiler
    export MANDATE_OPA VITEST_REPORT="$RUNNER_TEMP/acs-report.json"
    npx vitest run test/acs.test.ts --reporter=verbose --reporter=json --outputFile.json="$VITEST_REPORT"
    node ../scripts/assert-ran.mjs "$VITEST_REPORT" "the generated Rego on a real OPA"
  )
  # ci.yml starts the collector with `docker run`; here the script has started the compose service, with this commit's
  # runtime/test/otel-collector.yaml, before this job. Ready when the receiver answers at all (a GET of the traces path
  # is answered 405).
  step "The OpenTelemetry Collector 0.165.0 answers"
  ready=0
  for i in $(seq 1 60); do
    code="$(curl -s -o /dev/null -w '%{http_code}' http://otel-collector:4318/v1/traces || true)"
    if [ "$code" != "000" ]; then echo "the collector's receiver answered $code after $i s"; ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then echo "::error::the collector's receiver did not answer within 60 s"; exit 1; fi
  step "mandate otel export against the real OpenTelemetry Collector, run and not skipped"
  (
    cd runtime
    export MANDATE_OTEL_COLLECTOR=http://otel-collector:4318 MANDATE_OTEL_COLLECTOR_OUT=/otel/out/spans.json VITEST_REPORT="$RUNNER_TEMP/otel-collector-report.json"
    npx vitest run test/otel-collector.test.ts --reporter=verbose --reporter=json --outputFile.json="$VITEST_REPORT"
    node ../scripts/assert-ran.mjs "$VITEST_REPORT" "mandate otel export against a real OpenTelemetry Collector"
  )
}

job_sandbox() {
  use_node 24
  step "Bubblewrap and slirp4netns (from the image; the container's own user namespaces are what is tried here)"
  bwrap --version
  slirp4netns --version | head -n 1
  step "npm ci --ignore-scripts"
  npm ci --ignore-scripts
  step "Install the pinned Rust toolchain"
  rustup toolchain install
  step "Build the Rust compiler's WebAssembly module"
  npm run build:wasm
  # /work is empty and owned by the job's user in the image (CI makes it with sudo).
  # Three tests of mxc.test.ts ("no service socket of the host reaches a sandbox") take as their control a socket the
  # GitHub runner has: systemd-resolved's, at /run/systemd/resolve/io.systemd.Resolve. A container has no systemd, so
  # a stand-in listens at that path (it answers a request with an error and closes), and the tests show that the sandbox's masks
  # hide a real socket there. It is a stand-in for the runner's resolver, not the resolver (docker/README.md).
  step "A stand-in for systemd-resolved's socket, the control of three tests of mxc.test.ts"
  python3 - >"$RUNNER_TEMP/resolver-standin.log" 2>&1 <<'PY'
import os, socket
p = "/run/systemd/resolve/io.systemd.Resolve"
if os.path.exists(p):
    os.unlink(p)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(p)
s.listen(16)
if os.fork() == 0:
    os.setsid()
    while True:
        c, _ = s.accept()
        c.settimeout(1)
        try:
            c.recv(4096)
            c.sendall(b'{"error":"stand-in"}' + bytes(1))
        except OSError:
            pass
        c.close()
PY
  for i in 1 2 3 4 5 6 7 8 9 10; do
    [ -S /run/systemd/resolve/io.systemd.Resolve ] && break
    sleep 0.3
  done
  if [ ! -S /run/systemd/resolve/io.systemd.Resolve ]; then
    echo "::error::the stand-in for systemd-resolved's socket did not start; its output:"
    cat "$RUNNER_TEMP/resolver-standin.log"
    exit 1
  fi
  ls -l /run/systemd/resolve/
  step "Sandbox enforcement on Bubblewrap (G05, G07), sandbox egress through the proxy (G15, G16), the acceptance of 0.5 in a real sandbox, the Gate 3 rehearsal, and two components in two sandboxes (B3)"
  (
    cd runtime
    export MANDATE_MXC=1 MANDATE_ACCEPTANCE_OUT="$RUNNER_TEMP/acceptance"
    npx vitest run test/mxc.test.ts test/sandbox-egress.test.ts test/boundary-acceptance.test.ts test/gate3.test.ts test/workspace.test.ts
  )
  # CI-only: runtime/test/container.test.ts needs a real Docker engine (MANDATE_CONTAINER=1), and the container has none.
  step "The container sandbox host on a real Docker engine (G05, G07): NOT RUN here, CI only"
  step "Build verify-journal"
  cargo build --locked -p verify-journal
  step "verify-journal verifies the export of the run in the real sandbox, and finds the event changed in the next"
  ACCEPTANCE="$RUNNER_TEMP/acceptance"
  for f in run.json tampered.json cp.pub.pem tampered-seq; do
    if [ ! -s "$ACCEPTANCE/$f" ]; then echo "::error::the acceptance test left no $f"; exit 1; fi
  done
  verify() { cargo run --locked --quiet -p verify-journal -- "$@"; }

  code=0
  verify "$ACCEPTANCE/run.json" --key "$ACCEPTANCE/cp.pub.pem" > "$ACCEPTANCE/rust-report.json" || code=$?
  cat "$ACCEPTANCE/rust-report.json"
  if [ "$code" -ne 0 ]; then echo "::error::the export of the run: exit $code, not 0"; exit 1; fi
  grep -q '^  "status": "verified",$' "$ACCEPTANCE/rust-report.json"

  code=0
  verify "$ACCEPTANCE/tampered.json" --key "$ACCEPTANCE/cp.pub.pem" > "$ACCEPTANCE/rust-tampered.json" || code=$?
  cat "$ACCEPTANCE/rust-tampered.json"
  if [ "$code" -ne 1 ]; then echo "::error::the export with one event changed: exit $code, not 1"; exit 1; fi
  seq="$(cat "$ACCEPTANCE/tampered-seq")"
  grep -A1 '"code": "chain_broken",' "$ACCEPTANCE/rust-tampered.json" | grep -q "\"seq\": $seq\$"
}

# The assertions of `scripts/docker-ci.sh selfcheck` that can be made from inside the container. Names only: no value
# of any variable is read or printed.
job_selfcheck() {
  fail=0
  ok() { echo "ok:   $*"; }
  bad() { echo "FAIL: $*"; fail=1; }

  found="$(find /ci /cache /otel /work /home/ci -name .env 2>/dev/null || true)"
  if [ -z "$found" ]; then ok "no file named .env in the clone (/ci), the caches (/cache), /otel, /work or the home directory"; else bad "a .env exists: $found"; fi

  for name in CLAUDE_API_KEY CLAUDE_WORKSPACE_ID MANDATE_GITHUB_TOKEN GITHUB_TOKEN GH_TOKEN ANTHROPIC_API_KEY; do
    if env | cut -d= -f1 | grep -qx "$name"; then bad "the variable $name is set"; else ok "the variable $name is not set"; fi
  done

  if [ -e /git ]; then bad "/git exists: a git directory of the host is mounted"; else ok "no /git: the host's git directory is not mounted"; fi
  if [ "$(git -C /ci/repo rev-list --count HEAD)" = 1 ]; then ok "the clone has one commit, made from the archive of $sha"; else bad "the clone does not have exactly one commit"; fi
  if [ -z "$(git -C /ci/repo status --porcelain)" ]; then ok "the clone has no change and no untracked file"; else bad "the clone is not clean"; fi
  setuid="$(find / -xdev \( -perm -4000 -o -perm -2000 \) -type f 2>/dev/null | head -n 5 || true)"
  if [ -z "$setuid" ]; then ok "no setuid or setgid file in the image"; else bad "setuid or setgid files: $setuid"; fi

  if [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then bad "a Docker socket is present"; else ok "no Docker socket"; fi
  if [ "$(id -u)" = 1000 ]; then ok "runs as uid 1000, not root"; else bad "runs as uid $(id -u)"; fi
  # The effective capabilities of the process: none for the runner (cap_drop: ALL, and no cap_add anywhere).
  echo "info: effective capabilities $(grep '^CapEff' /proc/self/status | cut -f2)"
  if [ -d /mnt/c ] || [ -d /c/Users ]; then bad "a Windows drive is visible"; else ok "no Windows drive visible"; fi
  [ "$fail" = 0 ]
}

case "$job" in
  rust) job_rust ;;
  parity) job_parity ;;
  test) job_test ;;
  sandbox) job_sandbox ;;
  selfcheck) job_selfcheck ;;
  quick)
    case "${MANDATE_CI_NODE:-24}" in 22 | 24) use_node "${MANDATE_CI_NODE:-24}" ;; *) echo "MANDATE_CI_NODE must be 22 or 24"; exit 2 ;; esac
    [ "$#" -gt 0 ] || { echo "quick needs a command"; exit 2; }
    "$@"
    ;;
  *) echo "unknown job $job"; exit 2 ;;
esac
