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
not the working tree (uncommitted changes are not in it). The exit status is the job's result, and the last line names
the job and the commit. Run at most two jobs at once: the runtime's tests have 30 s process tests and a 2 s check
budget, and fail with time-outs under load (rerun the job alone before concluding anything). Two `test` jobs at once
are refused: they would share the PostgreSQL server and the collector.

`quick` starts with an empty clone: for a Node command run `npm ci --ignore-scripts` first, e.g.
`quick HEAD -- sh -c 'npm ci --ignore-scripts && npm test -w runtime'`. `MANDATE_CI_NODE=22` selects Node 22 (default 24).

## What is in the image (`Dockerfile`)

Ubuntu 24.04 (by digest); Rust 1.100.0 with rustfmt, clippy, the `wasm32-wasip1` target and the minimal profile, as
`rust-toolchain.toml` pins it (rustup-init of rustup 1.28.2 checked by sha256); Node 22.23.4 and 24.22.1 side by side
(official tarballs, sha256 checked; the `test` job uses 22, the others 24, as in `ci.yml`); OPA 1.4.2 (the static
binary, the sha256 of `ci.yml`); git, curl, a C toolchain, python3, bubblewrap, slirp4netns, iptables, iproute2,
util-linux. The jobs run as the user `ci` (uid 1000), not root. `compose.yml` adds a PostgreSQL 16.15 and an
OpenTelemetry Collector 0.165.0 by the digests of `ci.yml`. `check.mjs` (also run by the `rust` job of `ci.yml`) fails
when a Rust, Node, OPA, PostgreSQL or collector value here differs from `rust-toolchain.toml` or `ci.yml`, and when
something below is broken.

The image is built from the directory `docker/` alone. `run-job.sh`, in the image, holds the steps of each job in
the order of `ci.yml`; `scripts/docker-ci.sh` starts it.

## Caches

Named volumes of the project `mandate-ci` (`docker volume ls`): `cargo-home` (the cargo registry and git caches, at
`/cache/cargo`), `cargo-target` (the target directory, mounted at `/ci/repo/target`, because
`scripts/build-wasm.mjs` reads `target/` and not `CARGO_TARGET_DIR`), `npm-cache` (at `/cache/npm`), and `otel-config`
and `otel-out` (the collector's configuration and output, below). `node_modules` is not cached: every run starts with
`npm ci`. Two jobs share the caches; cargo locks the target directory.
`scripts/docker-ci.sh clean` removes this project's containers, network and volumes and nothing else (never a prune).

## What is deliberately impossible (the secret boundary)

The repository root has a `.env` file with live secrets. It cannot reach a container:

- The image build context is `docker/`. The working tree of the host is never mounted. The only bind mount is the
  repository's git directory (`git rev-parse --git-common-dir`), read-only, at `/git`; the container clones the commit
  from it. A `.env` is not in the git directory, and none is ever committed.
- No `env_file`, no `environment` entry without a value, no host variable passed through: the containers have only the
  variables written in the Dockerfile and `run-job.sh`, and `quick` passes `MANDATE_CI_NODE` (22 or 24) and nothing else.
- Docker Compose loads a `.env` of its project directory by itself. Every call passes `--project-directory docker` and
  `--env-file docker/empty.env` (a committed empty file), and the script unsets every `COMPOSE_*` variable, so no
  `.env` is read from the current directory or anywhere else. `selfcheck` proves it with a decoy.
- No Docker socket, no `--privileged`, no host network, PID or IPC namespace, no published port: the services are
  reached on the private network of the project. PostgreSQL uses trust authentication on that network (no password in
  any file; the URL is `postgresql://mandate@postgres:5432/mandate_test`).
- The runner has no capability (`cap_drop: ALL`) and `no-new-privileges`. Only the `sandbox` service has more (below).
- No credential-shaped value is in these files; every download is checked by a sha256 written in the Dockerfile.

`docker/check.mjs` fails if a file of `docker/` or `scripts/docker-ci.sh` gains one of these; `scripts/docker-ci.sh
selfcheck` checks the container itself: no `.env` in the clone or any mount, none of `CLAUDE_API_KEY`,
`CLAUDE_WORKSPACE_ID`, `MANDATE_GITHUB_TOKEN`, `GITHUB_TOKEN`, `GH_TOKEN`, `ANTHROPIC_API_KEY` set (names only), the git
mount read-only, the one bind mount, no socket, not privileged, and the decoy test (a `.env` in the current directory
does not reach a container; a control shows that compose would read it if it were not told not to).

## The `test` job and the collector

In CI the collector is started with `docker run` and bind mounts. Here there is no host tree and no socket: before the
job the script copies the commit's `runtime/test/otel-collector.yaml` (read from the git objects) into the `otel-config`
volume, starts the collector as uid 1000 (as in CI, so that the file it writes can be read) with that volume at
`/etc/otelcol` and `otel-out` at `/out`, and the runner reads `/otel/out/spans.json` from the same volume. The
runner reaches it at `http://otel-collector:4318`. PostgreSQL and the collector are stopped after the job.

## What differs from CI, and what stays CI-only

- The database URL is `postgresql://mandate@postgres:5432/mandate_test` (a service name, trust authentication) and the
  collector is `http://otel-collector:4318`, not `localhost` with a password.
- The collector's readiness is a `curl` loop from the runner (a GET of the traces path answers 405), as in CI, with the
  container state checked by `docker compose up --wait` instead of `docker inspect`.
- OPA is in the image (checked at build) instead of downloaded in the job. `rustup toolchain install` still runs; the
  toolchain is already there. The Rust job step "docker/check.mjs" is skipped on a commit that does not have the file.
- One Ubuntu (24.04) and the kernel of Docker Desktop's WSL2 VM, not the `ubuntu-22.04` / `ubuntu-24.04` matrix.
- `sandbox-windows` (an AppContainer on Windows) is CI-only.
- `sandbox`: runs in the `runner-sandbox` service, which has `seccomp=unconfined`, `apparmor=unconfined`, `SYS_ADMIN`
  and `NET_ADMIN` (not privileged) and the device `/dev/net/tun` (slirp4netns needs it), so that Bubblewrap has user
  namespaces. It runs the five files of the job (`mxc`, `sandbox-egress`, `boundary-acceptance`, `gate3`, `workspace`:
  89 tests, none skipped) and `verify-journal` on the run they leave. Three tests of `mxc.test.ts` use as their control the
  socket of systemd-resolved, which the GitHub runner has and a container does not: `run-job.sh` starts a stand-in
  that listens at `/run/systemd/resolve/io.systemd.Resolve` and answers with an error, so the tests show that the
  sandbox's masks hide a real socket at that path; and one test needs a writable `/run/user/1000`, which the image has.
  **Not run here: the container sandbox host on a real Docker engine** (`container.test.ts`, `MANDATE_CONTAINER=1`): it
  needs an engine, and the runner has no socket.
- `apt` packages are not pinned to versions (the base image is by digest).

## Durations on the development machine

Windows 11, Docker Desktop (WSL2, 20 CPUs, 31 GiB), commit `751d1ae`. "Cold": empty cargo and npm volumes. "Warm":
caches filled by an earlier run. A fresh clone makes cargo rebuild the workspace crates, and most of the time is tests.

| What | Cold | Warm |
|---|---|---|
| `build` (image, base image already pulled) | 94 s | 1 s |
| `rust` | 224 s | 207 s |
| `test` | 639 s (includes pulling the two service images) | 603 s |
| `parity` | 55 s | 36 s |
| `sandbox` | 92 s | 46 s |
