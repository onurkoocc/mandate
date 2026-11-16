# Running the CI jobs in Docker

The jobs of `.github/workflows/ci.yml` (`rust`, `test`, `parity`, `sandbox`) run here in Docker, on a commit, so that a
slice is verified before its pull request. Native `cargo test` and `cargo clippy` cannot run on the Windows
development machine (Smart App Control blocks freshly built executables, and stays on); in the container they run
natively, as in CI.

    scripts/docker-ci.sh rust [<commit>]
    scripts/docker-ci.sh test [<commit>]
    scripts/docker-ci.sh parity [<commit>]
    scripts/docker-ci.sh sandbox [<commit>]
    scripts/docker-ci.sh quick [<commit>] -- <command...>   # one command in the clone, e.g.
                                                           #   quick HEAD -- cargo test -p mandate-ir --test tags
    scripts/docker-ci.sh build | selfcheck | clean

Run it from Git Bash on Windows or from a shell on Linux. The commit defaults to `HEAD`; the commit is what is tested,
not the working tree (the script warns when the working tree has uncommitted changes and the commit is `HEAD`). The
exit status is the job's result, and the last line names the job and the commit (the `sandbox` line also names what is
CI-only).

`quick` starts with an empty clone: for a Node command run `npm ci --ignore-scripts` first, e.g.
`quick HEAD -- sh -c 'npm ci --ignore-scripts && npm test -w runtime'`. `MANDATE_CI_NODE=22` selects Node 22 (default 24).

## How a commit gets into the container

Nothing of the host is mounted: there is no bind mount at all. The script makes **a pack of exactly the commit, its trees
and its blobs** (`git rev-list --objects --no-walk <commit> | git pack-objects --stdout`, from git's own objects: no
working tree, no host-side filter, no `core.autocrlf`, no `export-subst`, no attributes are involved) and pipes it to
the standard input of the container. `docker/boot.sh` (fixed, in the image) does what CI's `actions/checkout` does: an
empty repository, `git unpack-objects --strict`, the repository marked shallow at the commit, and `git checkout --detach`
of the commit, made by the container's own git. **HEAD is the real commit id**; `boot.sh` asserts that `git rev-parse
HEAD` is the sha it was given, that `git status --porcelain` is empty and that `git fsck --connectivity-only` is clean.
The log prints the tested sha.

The job steps travel with the commit: `boot.sh` runs the tested commit's own `docker/run-job.sh`. A commit from
before `docker/` existed (for example `751d1ae`) has none, and `boot.sh` runs the copy baked into the image and says so
(`steps: the copy baked into the image`).

### The image, and which checkout built it

`mandate-ci-runner:local` is one tag, shared by every worktree. The script gives `boot.sh` the digest of the
`Dockerfile`, `.dockerignore` and `boot.sh` of the checkout that started the job; the image holds copies of those three
files (the one `COPY`, which is the last instruction of the Dockerfile, so that a rebuild for other scripts costs
nothing) and `boot.sh` hashes them. If they differ, `boot.sh` exits with the status 97 before it does anything else
(a job that returns 97 is reported as 1, so 97 means this and nothing else), and the script builds the image again and
tries again, up to five times, saying so each time. `run-job.sh` is not in that digest: its copy in the image is checked
against the digest of the starting checkout's `run-job.sh` only when the copy is used (a commit that has none). A job
never runs on another checkout's image.

## What is in the image (`Dockerfile`)

Ubuntu 24.04 (by digest); Rust 1.100.0 with rustfmt, clippy, the `wasm32-wasip1` target and the minimal profile, as
`rust-toolchain.toml` pins it (rustup-init of rustup 1.28.2 checked by sha256); Node 22.23.4 and 24.22.1 side by side
(official tarballs, sha256 checked; the `test` job uses 22, the others 24, as in `ci.yml`); OPA 1.4.2 (the static
binary, the sha256 of `ci.yml`); git, curl, a C toolchain, python3, bubblewrap, slirp4netns, iptables, iproute2,
util-linux. The jobs run as the user `ci` (uid 1000), not root. No setuid or setgid bit is left on any file of the
image. `compose.yml` adds a PostgreSQL 16.15 and an OpenTelemetry Collector 0.165.0 by the digests of `ci.yml`.
`.dockerignore` admits only the two files the one `COPY` names.

## Checks that the environment is what CI pins and is closed (`check.mjs`)

`node docker/check.mjs` (run by the `rust` job of `ci.yml`, and by the `rust` job here) fails when:

- a Rust, Node, OPA, PostgreSQL or collector value of `docker/` differs from `rust-toolchain.toml` or `ci.yml`;
- `compose.yml` holds a `$`, a flow mapping, or a key that opens a path from the host (`env_file`, `extends`, `include`,
  `secrets`, `configs`, `ssh`, `privileged`, `pid`/`ipc`/`uts`/`cgroup`, `network_mode`, `ports`, `cap_add`,
  `driver_opts`, `bind`, `args`, ...); or the compose file **as Compose resolves it** (`docker compose config --format
  json`) has a key or a value that is not on an allowlist (top-level keys, and the keys and values of each of the four
  services). This part runs where `docker compose` exists, and where it does not (inside the job container) it says it
  was skipped; in GitHub Actions its absence is a failure;
- **every line of `scripts/docker-ci.sh` that reaches Docker or feeds a container is not one of the lines pinned in
  `check.mjs`, exactly** (after joining continuation lines and normalising whitespace): a call of `docker`, `dc`,
  `dcp` or `pack_of_commit`, anything piped into them, `eval`, `source`, a pipe into a shell, a variable or a
  substitution run as a command (`d=docker; "$d" cp ...`, with quote concatenation undone). Changing an invocation, or
  adding one, is a visible change of that list. In every other line the flags that open a path from the host (`-v`,
  `--mount`, `--user`, `--entrypoint`, `--env-file`, `--env-from-file`, `--add-file`, privileges, host namespaces,
  published ports, quoted or not) are refused, every `-e`/`--env` must carry `NAME=value` with a literal or one of the
  script's own variables, the `COMPOSE_*` unset loop must be there, and `eval` must not;
- the Dockerfile has more than the one `COPY` (which must be the last instruction before `USER ci`, after the strip of
  setuid bits), an `ADD`, a `--mount`, `--secret` or `--ssh`, or an `ARG` without a default; `.dockerignore` is not
  exactly `*` and the four files of the `COPY`;
- a step (`run:`) of the `rust`, `test`, `parity` or `sandbox` job of `ci.yml` is not in `docker/run-job.sh`: **each of its
  command lines must be a whole line of the matching `job_*` function** (in order; `(cd X && ...)` counts as `cd X` and the
  rest), a leading `NAME=value` only when the step's `env:` has it (the known differences are listed with their reasons:
  the PostgreSQL URL, `MANDATE_OPA` and the collector's address and output), every `env:` variable of the step must be set
  to its value on a line of the step or before it, and a step's `working-directory` must be a `cd` before its lines. The
  steps that are not there are on a short list in `check.mjs`, each with its reason: the apt and sysctl step, `sudo mkdir
  /work`, the container-host test, the OPA download, starting, logging and removing the collector with `docker run`;
- `run-job.sh` or `boot.sh` lacks `set -eu` before its first function, or has `set +e`, or a line with `||` that is neither
  `|| code=$?` (the form of `ci.yml` itself) nor one of the few listed lines (`|| true` and `|| :` make a failing command
  pass); `boot.sh` must contain, in order, its header, the image digest check, the shallow checkout of the commit, the
  assertion that HEAD is the commit, the clean-status and `fsck` checks and the run of the steps, and no other way of
  making the checkout (`git add`, `git config`, `autocrlf`, `curl`).

What this does not catch: a line of `run-job.sh` that does something in addition to the line of the step (the extra lines
of a function are not compared with `ci.yml`; they are the adaptations: the collector wait, the OPA path, the stand-in
resolver), a step whose environment is set by a line that is not an assignment (a sourced file), the content of the
scripts that a step runs (`npm test` runs whatever the commit says), and a pinned line that is itself changed together with
the pin in the same commit (the review of that diff is the control). The script reader is a small reader of shell words, not
a shell: a construction it does not understand is not in the pinned list and fails.

## Caches

Named volumes of the project `mandate-ci` (`docker volume ls`): `cargo-home` (the cargo registry and git caches, at
`/cache/cargo`), `npm-cache` (at `/cache/npm`), and `otel-config` and `otel-out` (the collector's configuration and
output, below). Only downloads are shared. **The cargo target directory and `node_modules` are in the container's own
file system, new for every run:** a job never builds on another job's artifacts (with a shared target, a job could pass
on another commit's build). Two jobs share the caches. `scripts/docker-ci.sh clean` removes this project's containers,
network and volumes and nothing else (never a prune).

## What is deliberately impossible (the secret boundary)

The repository root has a `.env` file with live secrets. It cannot reach a container:

- The image build context is `docker/` (admitting `Dockerfile`, `.dockerignore`, `boot.sh` and `run-job.sh` only). No directory of the host is mounted,
  neither the working tree nor the git directory: the commit arrives as a pack of its own objects on the standard input. A `.env` is
  not in a commit, so it is not in the pack.
- No `env_file`, no `environment` entry without a value, no host variable passed through: the containers have only the
  variables written in the Dockerfile, `run-job.sh` and the `-e NAME=value` flags of the script (the two digests of
  the files, and for `quick` the Node release 22 or 24).
- Docker Compose loads a `.env` of its project directory by itself. Every call passes `--project-directory docker` and
  `--env-file docker/empty.env` (a committed empty file), and the script unsets every `COMPOSE_*` variable, so no
  `.env` is read from the current directory or anywhere else. `compose.yml` has no variable at all, so nothing could be
  interpolated from one anyway. `selfcheck` proves it with a decoy.
- No Docker socket, no `--privileged`, no host network, PID or IPC namespace, no published port: the services are
  reached on the private network of the project. PostgreSQL uses trust authentication on that network (no password in
  any file; the URL is `postgresql://mandate@postgres:5432/mandate_test`).
- The runner has no capability (`cap_drop: ALL`) and `no-new-privileges`. The `sandbox` service has the same, and
  `seccomp=unconfined` and the device `/dev/net/tun` (below). Nothing is added with `cap_add`.
- No credential-shaped value is in these files; every download is checked by a sha256 written in the Dockerfile.

`scripts/docker-ci.sh selfcheck` checks the containers themselves, for the runner and for the sandbox service: no
bind mount whatsoever and only named volumes, the exact grant (capabilities, security options, devices; not privileged,
no host namespace, no published port), no `.env` in the clone or any mount, none of `CLAUDE_API_KEY`,
`CLAUDE_WORKSPACE_ID`, `MANDATE_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY` set (names only), no `/git`,
no socket, no setuid file, HEAD the tested commit in a shallow clone, and the decoy test (a `.env` in the current directory does not
reach a container; a control shows that compose would read it if it were not told not to).

**What the boundary does not cover.** The containers have internet access (npm, cargo and rustup need it) and can reach
the host through `host.docker.internal` and the host's other addresses; the code under test is not isolated from the
network. What it cannot do is read a file or a variable of the host, or the git history.

## The `test` job and the collector

In CI the collector is started with `docker run` and bind mounts. Here there is no host tree and no socket: before the
job the script copies the commit's `runtime/test/otel-collector.yaml` (read from the git objects) into the `otel-config`
volume, starts the collector as uid 1000 (as in CI, so that the file it writes can be read) with that volume at
`/etc/otelcol` and `otel-out` at `/out`, and the runner reads `/otel/out/spans.json` from the same volume. The
runner reaches it at `http://otel-collector:4318`. A commit without `runtime/test/otel-collector.yaml` is refused
before anything starts. PostgreSQL and the collector are removed after the job, on exit, interrupt and termination
(a `trap`).

## What may run at the same time

At most `MANDATE_CI_MAX_JOBS` (default 2) job containers run at once, across **all worktrees of the repository** (a place
is a lock directory, `mandate-ci-slot.N`, in the repository's common git directory); a job that has to wait says so every
30 s. `selfcheck` and `build` take no place. Two `test` jobs are never at the same time: they share the PostgreSQL and
collector services, so a second one waits for the first (`mandate-ci-test.lock`, in the same place) before it takes a place,
and a waiting job holds no place. The runtime's tests have 30 s process tests and a 2 s check budget, and fail with
time-outs under load: rerun the job alone before concluding anything. A lock is released when the job ends, on interrupt,
termination and hangup too (the job container is removed by name); it is recovered when stale (its process is gone, no
job container of its name and, for the test lock, no service of the project is running; or it is six hours old), and
the recovery is guarded by a directory of its own and decided again under the guard, so that two waiters cannot both recover
it, and a waiter that judged it stale earlier cannot remove the lock another waiter took after recovering it. (A holder whose
process is judged dead although it lives, which `kill -0` between separate Git Bash sessions could in principle say, would
lose its lock; the job container's name is checked as well to make that unlikely.) The jobs of a checkout from before this
limit take no place.

## What stays wider than needed, and why

- `seccomp=unconfined` on the `runner-sandbox` service. Bubblewrap needs user namespaces and `clone`/`unshare` flags that
  the default profile refuses; a profile made of Docker's default plus the few syscalls it needs would be narrower, and was
  not written. The service has no capability, no setuid binary, `no-new-privileges`, and only the `/dev/net/tun` device.
- The cargo registry cache (`cargo-home`) and the npm cache are writable by the code of the commit under test and are not
  verified again: a commit that poisons a cached crate or tarball affects the next job that uses the cache (the lock files
  and their hashes still apply to what cargo and npm unpack, but not to what a build script wrote into the cache).
  `clean` throws the caches away.
- Every container reaches the internet (npm, cargo and rustup need it) and the host through `host.docker.internal` and the
  host's other addresses. The code under test is not isolated from the network; it cannot read a file or a variable of the host.
- The collector's volumes (`otel-config`, `otel-out`) are mounted in every runner container, so every job can read and
  write them, including while a `test` job uses them; the `test` lock keeps two `test` jobs apart, not other jobs.

## What differs from CI, and what stays CI-only

- The database URL is `postgresql://mandate@postgres:5432/mandate_test` (a service name, trust authentication) and the
  collector is `http://otel-collector:4318`, not `localhost` with a password.
- The collector's readiness is a `curl` loop from the runner (a GET of the traces path answers 405), as in CI, with the
  container state checked by `docker compose up --wait` instead of `docker inspect`.
- OPA is in the image (checked at build) instead of downloaded in the job. `rustup toolchain install` still runs; the
  toolchain is already there. The `rust` job step "docker/check.mjs" is skipped on a commit that does not have the file.
- One Ubuntu (24.04) and the kernel of Docker Desktop's WSL2 VM, not the `ubuntu-22.04` / `ubuntu-24.04` matrix.
- `sandbox-windows` (an AppContainer on Windows) is CI-only.
- `sandbox`: runs in the `runner-sandbox` service, which has `seccomp=unconfined` (Bubblewrap needs user namespaces,
  which the default profile refuses), the device `/dev/net/tun` (slirp4netns opens it), `cap_drop: ALL` and
  `no-new-privileges`, and **no added capability**, no `apparmor` setting (it does nothing on this engine) and no
  setuid binary. It runs the five files of the job (`mxc`, `sandbox-egress`, `boundary-acceptance`, `gate3`,
  `workspace`: 89 tests, none skipped) and `verify-journal` on the run they leave. Three tests of `mxc.test.ts` use as
  their control the socket of systemd-resolved, which the GitHub runner has and a container does not: `run-job.sh`
  starts a stand-in that listens at `/run/systemd/resolve/io.systemd.Resolve` and answers with an error (its output is
  kept, and shown if it does not start), so the tests show that the sandbox's masks hide a real socket at that path; and
  one test needs a writable `/run/user/1000`, which the image has. **Not run here: the container sandbox host on a
  real Docker engine** (`container.test.ts`, `MANDATE_CONTAINER=1`): it needs an engine, and the runner has no socket.
  No test needed a grant beyond the list above.
- `apt` packages are not pinned to versions (the base image is by digest).

## Durations on the development machine

Windows 11, Docker Desktop (WSL2, 20 CPUs, 31 GiB). Every run now builds in a fresh target directory, so "cold" and
"warm" differ only by the cargo registry and npm caches. Measured on `751d1ae`, or on the head of the slice (`rust`, `quick`).

| What | Cold (empty cargo and npm volumes) | Warm |
|---|---|---|
| `build` (image, base image already pulled) | 50 s | 1 s |
| `rust` | 214 s | 197 s |
| `test` | not measured since the change of the target directory (639 s with the service images to pull) | 577 s |
| `parity` | not measured | 24 s |
| `sandbox` | not measured | 39 s |
| `quick -- cargo test -p mandate-ir --test tags` | 7 s | 6 s |

Most of the time is tests; the build directory is new every run, so the caches buy only downloads.
