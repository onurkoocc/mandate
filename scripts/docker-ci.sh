#!/usr/bin/env bash
# Runs a job of .github/workflows/ci.yml in Docker, on a commit of this repository (docker/README.md):
#
#   scripts/docker-ci.sh <rust|test|parity|sandbox> [<commit>]
#   scripts/docker-ci.sh quick [<commit>] -- <command...>     one command in the clone, e.g. cargo test -p mandate-ir
#   scripts/docker-ci.sh build | selfcheck | clean
#
# It tests a commit, not the working tree: the repository's git directory is mounted read-only into the container,
# which clones the commit (default HEAD) from it. The working tree of the host is never mounted, no environment variable
# of the host reaches a container, and no `.env` file is read by Docker Compose (every call passes
# `--project-directory docker --env-file docker/empty.env`). The exit status is the job's result.
#
# Run from Git Bash on Windows, or from a shell on Linux. Docker Desktop (or an engine) must be running.
set -u

# Git Bash would rewrite every argument that looks like a path; the paths below are made Windows-style where needed.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'

# A COMPOSE_* variable of the host (COMPOSE_FILE, COMPOSE_ENV_FILES, COMPOSE_PROJECT_NAME, ...) changes what compose reads.
for v in $(compgen -e | grep '^COMPOSE_' || true); do unset "$v"; done

die() { echo "docker-ci: $*" >&2; exit 2; }

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
docker_dir="$root/docker"
[ -f "$docker_dir/compose.yml" ] || die "no docker/compose.yml beside this script"

# The path as the docker CLI wants it: C:/Users/... under Git Bash on Windows, unchanged on Linux.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

root_native="$(native "$root")"
command -v docker >/dev/null 2>&1 || die "docker is not on the PATH"

# The common git directory: a slice is written in a git worktree whose .git is a file, and the objects are in the
# directory of the main checkout.
git_dir="$(git -C "$root_native" rev-parse --path-format=absolute --git-common-dir)" || die "not a git repository"
MANDATE_CI_GIT_DIR="$(native "$git_dir")"
export MANDATE_CI_GIT_DIR

# Compose, with nothing read from the current directory or the project directory but the files named here. The empty
# env file is what stops compose from loading a `.env` file; no `env_file` and no `${VAR}` of a host secret is in
# compose.yml either (docker/check.mjs).
dc() {
  docker compose --project-directory "$(native "$docker_dir")" --env-file "$(native "$docker_dir")/empty.env" \
    -f "$(native "$docker_dir")/compose.yml" "$@"
}

ensure_image() {
  local log
  log="$(mktemp)"
  if ! dc --profile run build runner >"$log" 2>&1; then
    cat "$log"
    rm -f "$log"
    die "the image did not build"
  fi
  rm -f "$log"
}

usage() {
  sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

job="${1:-}"
[ -n "$job" ] || usage
shift

commit_arg="HEAD"
cmd=()
if [ "$#" -gt 0 ] && [ "$1" != "--" ]; then
  commit_arg="$1"
  shift
fi
if [ "$#" -gt 0 ] && [ "$1" = "--" ]; then
  shift
  cmd=("$@")
elif [ "$#" -gt 0 ]; then
  die "unexpected arguments: $*"
fi

start="$(date +%s)"
finish() { # <label> <status>
  local took=$(($(date +%s) - start))
  if [ "$2" -eq 0 ]; then echo "docker-ci: $1 PASS (${took} s)"; else echo "docker-ci: $1 FAIL, exit $2 (${took} s)"; fi
  exit "$2"
}

resolve() {
  sha="$(git -C "$root_native" rev-parse --verify --quiet "$commit_arg^{commit}")" || die "no such commit: $commit_arg"
}

# Runs mandate-ci-job in a fresh container of the service. The only value passed in is the Node release of `quick`,
# validated here; nothing else of the host's environment.
run_in() { # <service> <args of mandate-ci-job...>
  local service="$1"
  shift
  local envs=()
  if [ -n "${MANDATE_CI_NODE:-}" ]; then
    case "$MANDATE_CI_NODE" in 22 | 24) envs=(-e "MANDATE_CI_NODE=$MANDATE_CI_NODE") ;; *) die "MANDATE_CI_NODE must be 22 or 24" ;; esac
  fi
  dc --profile run run --rm -T --no-deps "${envs[@]}" "$service" mandate-ci-job "$@"
}

run_test_job() {
  if [ -n "$(dc --profile services ps --status running -q postgres otel-collector 2>/dev/null)" ]; then
    die "the services of another test job are running; wait for it (or: scripts/docker-ci.sh clean)"
  fi
  local rc=0
  # This commit's collector configuration and an empty output directory, in the volumes the collector and the runner share.
  # (The runner image is used for the copy; the commit's file is read from the git objects on the host.)
  git -C "$root_native" show "$sha:runtime/test/otel-collector.yaml" |
    dc --profile run run --rm -T --no-deps runner sh -c 'cat > /otel/config/config.yaml && rm -f /otel/out/spans.json' || {
    echo "docker-ci: the commit has no runtime/test/otel-collector.yaml"
    return 1
  }
  dc --profile services up -d --wait postgres otel-collector || rc=$?
  if [ "$rc" -eq 0 ]; then run_in runner test "$sha" || rc=$?; fi
  if [ "$rc" -ne 0 ]; then
    echo "--- docker logs otel-collector (last 40 lines)"
    dc --profile services logs --no-color --tail 40 otel-collector 2>&1 || true
    echo "--- the collector's output file (first 2000 bytes)"
    dc --profile run run --rm -T --no-deps runner sh -c 'ls -l /otel/out; head -c 2000 /otel/out/spans.json' 2>&1 || true
  fi
  dc --profile services rm -sfv postgres otel-collector >/dev/null 2>&1 || true
  return "$rc"
}

selfcheck() {
  resolve
  ensure_image
  local fail=0
  cid="" tmp=""
  ok() { echo "ok:   $*"; }
  bad() { echo "FAIL: $*"; fail=1; }

  echo "--- the container, as Docker made it"
  cid="$(dc --profile run run -d -T --no-deps runner sleep 900)" || die "could not start the container"
  cid="$(printf '%s' "$cid" | tail -n 1)"
  trap 'if [ -n "$cid" ]; then docker rm -f "$cid" >/dev/null 2>&1; fi; if [ -n "$tmp" ]; then rm -rf "$tmp"; fi' EXIT
  local mounts
  mounts="$(docker inspect --format '{{range .Mounts}}{{.Type}} {{.Destination}} rw={{.RW}}{{"\n"}}{{end}}' "$cid")"
  local binds
  binds="$(printf '%s\n' "$mounts" | grep '^bind ' || true)"
  if [ "$(printf '%s\n' "$binds" | grep -c .)" = 1 ] && [ "$binds" = "bind /git rw=false" ]; then ok "the one bind mount is /git, read-only"; else bad "bind mounts: $binds"; fi
  if printf '%s\n' "$mounts" | grep -qE 'docker[.]sock'; then bad "a Docker socket is mounted"; else ok "no Docker socket mounted"; fi
  [ "$(docker inspect --format '{{.HostConfig.Privileged}}' "$cid")" = false ] && ok "not privileged" || bad "privileged"
  [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$cid")" != host ] && ok "not on the host network" || bad "host network"
  [ -z "$(docker inspect --format '{{.HostConfig.PidMode}}' "$cid")" ] && ok "not in the host PID namespace" || bad "host PID namespace"
  case "$(docker inspect --format '{{json .HostConfig.PortBindings}}' "$cid")" in '{}' | null) ok "no published port" ;; *) bad "a published port" ;; esac

  echo "--- inside the container, on a clone of $sha"
  docker exec "$cid" mandate-ci-job selfcheck "$sha" || fail=1
  docker rm -f "$cid" >/dev/null 2>&1

  echo "--- a dotenv file in the current directory does not reach a container"
  tmp="$(mktemp -d)"
  printf 'MANDATE_DECOY_PROBE=made-up-plain-words\n' >"$tmp/.env"
  cat >"$tmp/probe.yml" <<'EOF'
services:
  runner:
    environment:
      DECOY_PROBE: ${MANDATE_DECOY_PROBE:-absent}
EOF
  local ntmp
  ntmp="$(native "$tmp")"
  # The control: compose read in the way this script does not read it (project directory = the directory with the .env)
  # does load the file, so that the test below could fail.
  if (cd "$tmp" && docker compose --project-directory "$ntmp" --profile run -f "$(native "$docker_dir")/compose.yml" -f "$ntmp/probe.yml" config 2>/dev/null | grep -q 'made-up-plain-words'); then
    ok "control: compose does load the dotenv file of its project directory (the decoy shows in the resolved file)"
  else
    bad "control: the decoy did not show with the project directory beside it, so the test below proves nothing"
  fi
  # The real invocation, run from that directory.
  local out
  out="$(cd "$tmp" && docker compose --project-directory "$(native "$docker_dir")" --env-file "$(native "$docker_dir")/empty.env" \
    -f "$(native "$docker_dir")/compose.yml" -f "$ntmp/probe.yml" --profile run run --rm -T --no-deps runner sh -c 'printenv DECOY_PROBE; env | cut -d= -f1 | grep -c "^MANDATE_DECOY" || true' 2>/dev/null)"
  if [ "$(printf '%s\n' "$out" | sed -n 1p)" = absent ] && [ "$(printf '%s\n' "$out" | sed -n 2p)" = 0 ]; then
    ok "the decoy variable from ./dotenv does not reach the container (DECOY_PROBE=absent, no MANDATE_DECOY* in the environment)"
  else
    bad "the container saw: $out"
  fi

  echo "--- a variable of the host is not passed through"
  out="$(MANDATE_DECOY_HOST=made-up-plain-words dc --profile run run --rm -T --no-deps runner sh -c 'env | cut -d= -f1 | grep -c "^MANDATE_DECOY" || true' 2>&1 | tail -n 1)"
  if [ "$out" = 0 ]; then ok "an exported variable of the host is not in the container"; else bad "an exported variable of the host reached the container ($out)"; fi

  finish "selfcheck $sha" "$fail"
}

case "$job" in
  build)
    dc --profile run build runner
    finish "build" $?
    ;;
  clean)
    # This project's own containers, network and volumes (mandate-ci_*): nothing else.
    dc --profile run --profile services down -v --remove-orphans
    finish "clean" $?
    ;;
  selfcheck) selfcheck ;;
  rust | parity | test | sandbox | quick)
    resolve
    if [ "$job" = quick ] && [ "${#cmd[@]}" -eq 0 ]; then die "quick needs a command: quick [<commit>] -- <command...>"; fi
    if [ "$job" != quick ] && [ "${#cmd[@]}" -gt 0 ]; then die "only quick takes a command"; fi
    ensure_image
    echo "docker-ci: $job on ${sha}"
    rc=0
    case "$job" in
      test) run_test_job || rc=$? ;;
      sandbox) run_in runner-sandbox sandbox "$sha" || rc=$? ;;
      quick) run_in runner quick "$sha" "${cmd[@]}" || rc=$? ;;
      *) run_in runner "$job" "$sha" || rc=$? ;;
    esac
    finish "$job $sha" "$rc"
    ;;
  *) usage ;;
esac
