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

Nothing of the host is mounted: there is no bind mount at all. The script runs `git archive --format=tar <commit>` on the
host and pipes it to the standard input of the container. `docker/boot.sh` (fixed, in the image) extracts it into
`/ci/repo`, makes a git repository of it with **one commit** under a fixed identity (so that `git status` and `git diff`
work for the steps that use them; CI's own checkout is depth 1 too, and no step reads history), checks that the tree
of that commit is the tested commit's tree (so the archive gave exactly the commit's files, modes included), and runs
the job. **The commit in the clone is not the tested commit: its id differs, its tree is the same.** The log prints
the tested sha, the tree and the clone's commit. `.gitattributes` has no `export-ignore`, and `check.mjs` fails if it
gains one; file modes survive the archive (the tree comparison covers them).

The job steps travel with the commit: `boot.sh` runs the tested commit's own `docker/run-job.sh`. A commit from
before `docker/` existed (for example `751d1ae`) has none, and `boot.sh` runs the copy baked into the image and says so
(`steps: the copy baked into the image`). The script gives `boot.sh` the digest of the `boot.sh` and `run-job.sh` of the
checkout that started it; if another checkout rebuilt the image under the same tag in between, `boot.sh` stops with a
message instead of running the other's steps.

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
- `scripts/docker-ci.sh` calls Docker in a form that is not on an exact list (the `dc` wrapper with its one `-f`, the
  selfcheck's probe wrapper and control, `docker inspect`, `docker exec -i` of the selfcheck, `docker rm -f`), passes `-e`
  without `NAME=value`, mounts anything (`-v`, `--volume`, `--mount`, `docker cp`), or uses a privilege flag or a host
  namespace;
- the Dockerfile has more than the one `COPY`, an `ADD`, a `--mount`, `--secret` or `--ssh`, or an `ARG` without a default;
- a step (`run:`) of the `rust`, `test`, `parity` or `sandbox` job of `ci.yml` is not in `docker/run-job.sh` (its command
  lines, in order), except the steps on the list of known differences in `check.mjs`, each with its reason: the apt and
  sysctl step, `sudo mkdir /work`, the container-host test, the OPA download, starting, logging and removing the collector
  with `docker run`.

## Caches

Named volumes of the project `mandate-ci` (`docker volume ls`): `cargo-home` (the cargo registry and git caches, at
`/cache/cargo`), `npm-cache` (at `/cache/npm`), and `otel-config` and `otel-out` (the collector's configuration and
output, below). Only downloads are shared. **The cargo target directory and `node_modules` are in the container's own
file system, new for every run:** a job never builds on another job's artifacts (with a shared target, a job could pass
on another commit's build). Two jobs share the caches. `scripts/docker-ci.sh clean` removes this project's containers,
network and volumes and nothing else (never a prune).

## What is deliberately impossible (the secret boundary)

The repository root has a `.env` file with live secrets. It cannot reach a container:

- The image build context is `docker/` (admitting `boot.sh` and `run-job.sh` only). No directory of the host is mounted,
  neither the working tree nor the git directory: the commit arrives as an archive on the standard input. A `.env` is
  not in a commit, so it is not in the archive.
- No `env_file`, no `environment` entry without a value, no host variable passed through: the containers have only the
  variables written in the Dockerfile, `run-job.sh` and the `-e NAME=value` flags of the script (the digest of the two
  files, and for `quick` the Node release 22 or 24).
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
no socket, no setuid file, one commit in the clone, and the decoy test (a `.env` in the current directory does not
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

Any jobs, except two `test` jobs: they share the PostgreSQL and collector services (and the collector's volumes), so
the second one **waits** for the first (it prints that it waits, every 30 s). The lock is a directory in the repository's
common git directory, `mandate-ci-test.lock`, shared by every worktree of the repository; it is released when the job
ends, and recovered when stale (its process is gone and no service of the project is running, or it is more than four
hours old). Keep to at most two Docker jobs at a time: the runtime's tests have 30 s process tests and a 2 s check
budget, and fail with time-outs under load (rerun the job alone before concluding anything).

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
- The clone has one commit whose id is not the tested commit's.

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
