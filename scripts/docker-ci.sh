#!/usr/bin/env bash
# Runs a job of .github/workflows/ci.yml in Docker, on a commit of this repository (docker/README.md):
#
#   scripts/docker-ci.sh <rust|test|parity|sandbox> [<commit>]
#   scripts/docker-ci.sh quick [<commit>] -- <command...>     one command in the clone, e.g. cargo test -p mandate-ir
#   scripts/docker-ci.sh build | selfcheck | clean
#
# It tests a commit, not the working tree: a pack of exactly that commit, its trees and its blobs is piped into the
# container, which checks it out there. Nothing of the host is mounted into a container (no bind mount at all), no
# environment variable of the host reaches a container, and no dotenv file is read by Docker Compose (every call passes
# `--project-directory docker --env-file docker/empty.env`). The exit status is the job's result. At most
# MANDATE_CI_MAX_JOBS (default 2) jobs run at once across all worktrees of the repository; the others wait.
#
# Run from Git Bash on Windows, or from a shell on Linux. Docker Desktop (or an engine) must be running.
# docker/check.mjs pins every line of this file that reaches Docker or feeds a container, exactly: changing one is a
# visible change of that check.
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

# The path as the Docker CLI wants it: C:/Users/... under Git Bash on Windows, unchanged on Linux.
native() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

root_native="$(native "$root")"
command -v docker >/dev/null 2>&1 || die "Docker is not on the PATH"
dd="$(native "$docker_dir")"

# Compose, reading nothing from the current directory or the project directory but the files named here. The empty
# env file is what stops compose from loading a dotenv file; compose.yml has no env_file and no variable either.
dc() { docker compose --project-directory "$dd" --env-file "$dd/empty.env" -f "$dd/compose.yml" "$@"; }
# The same with one more compose file, for the probe of the selfcheck only.
dcp() { docker compose --project-directory "$dd" --env-file "$dd/empty.env" -f "$dd/compose.yml" -f "$1" "${@:2}"; }
# The one call that does not stop compose from reading a dotenv file, the control of the selfcheck: it shows that compose
# would read it.
control_loads_dotenv() { ( cd "$tmp" && docker compose --project-directory "$ntmp" --profile run -f "$dd/compose.yml" -f "$ntmp/probe.yml" config 2>/dev/null | grep -q 'made-up-plain-words' ); }
# The other Docker calls, all on a container this script started.
insp() { docker inspect --format "$2" "$1"; }
rm_container() { docker rm -f "$1" >/dev/null 2>&1; }
container_of() { docker ps -aq --filter "name=^$1\$"; }
# What goes into a container: a pack of exactly one commit, its trees and its blobs, made from git's objects with no
# conversion of any kind (no working tree, no filter, no autocrlf, no export-subst, no attributes, no replace refs).
pack_of_commit() { git --no-replace-objects -C "$root_native" rev-list --objects --no-walk "$1" | git --no-replace-objects -C "$root_native" pack-objects --stdout -q; }

usage() {
  sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//' >&2
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

max_jobs="${MANDATE_CI_MAX_JOBS:-2}"
case "$max_jobs" in '' | *[!0-9]* | 0) die "MANDATE_CI_MAX_JOBS must be a whole number of at least 1" ;; esac

start="$(date +%s)"
finish() { # <label> <status>
  local took=$(($(date +%s) - start))
  if [ "$2" -eq 0 ]; then echo "docker-ci: $1 PASS (${took} s)"; else echo "docker-ci: $1 FAIL, exit $2 (${took} s)"; fi
  exit "$2"
}

resolve() {
  sha="$(git -C "$root_native" rev-parse --verify --quiet "$commit_arg^{commit}")" || die "no such commit: $commit_arg"
  # What decides whether an image is the one this checkout built: the digest of the Dockerfile, .dockerignore and boot.sh
  # (boot.sh computes the same from its copies in the image), and, for a commit that has no run-job.sh of its own, the
  # digest of run-job.sh.
  image_digest="$(cat "$docker_dir/Dockerfile" "$docker_dir/.dockerignore" "$docker_dir/boot.sh" | sha256sum | cut -d' ' -f1)"
  steps_digest="$(sha256sum <"$docker_dir/run-job.sh" | cut -d' ' -f1)"
  if [ "$commit_arg" = HEAD ]; then
    local dirty
    dirty="$(git -C "$root_native" status --porcelain)"
    if [ -n "$dirty" ]; then
      echo "docker-ci: WARNING: the working tree has uncommitted changes, which are NOT tested (the commit $sha is):" >&2
      printf '%s\n' "$dirty" | head -n 10 | sed 's/^/docker-ci:   /' >&2
    fi
  fi
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

# ── locks: slots for the jobs, and the one of the test job; directories in the common git directory, so that every
#    worktree of the repository shares them ─────────────────────────────────────────────────────────────────────

git_dir="$(git -C "$root_native" rev-parse --path-format=absolute --git-common-dir)" || die "not a git repository"
test_lock="$git_dir/mandate-ci-test.lock"
held_test=0
slot_dir=""

# Whether the holder of a lock is gone: its process does not exist and no job container of its name exists. (Services a
# killed test job left running do not keep its lock: the next test job removes them once it has the lock.) A lock with no
# process recorded is stale when it is two minutes old (its holder died between making the directory and writing its
# process); one that is six hours old is stale whatever.
lock_stale() { # <dir>
  local d="$1" pid
  [ -d "$d" ] || return 1
  if [ -n "$(find "$d" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then return 0; fi
  pid="$(cat "$d/pid" 2>/dev/null || true)"
  if [ -z "$pid" ]; then [ -n "$(find "$d" -maxdepth 0 -mmin +2 2>/dev/null)" ]; return; fi
  if kill -0 "$pid" 2>/dev/null; then return 1; fi
  if [ -n "$(container_of "mandate-ci-job-$pid")" ]; then return 1; fi
  return 0
}

# Takes the lock directory if it is free, or if it is stale. Recovery is guarded by a directory of its own and decided
# again under the guard, so that a waiter that judged the lock stale earlier cannot remove the lock that another waiter
# recovered and took in the meantime.
try_lock() { # <dir>
  local d="$1"
  if mkdir "$d" 2>/dev/null; then printf '%s\n' "$$" >"$d/pid"; return 0; fi
  if lock_stale "$d"; then
    if mkdir "$d.recover" 2>/dev/null; then
      if lock_stale "$d"; then
        echo "docker-ci: recovering a stale lock ($(basename "$d"), holder $(cat "$d/pid" 2>/dev/null || echo unknown))"
        rm -rf "$d"
      fi
      rmdir "$d.recover"
    elif [ -n "$(find "$d.recover" -maxdepth 0 -mmin +2 2>/dev/null)" ]; then
      rmdir "$d.recover" 2>/dev/null || true
    fi
    if mkdir "$d" 2>/dev/null; then printf '%s\n' "$$" >"$d/pid"; return 0; fi
  fi
  return 1
}

lock_release() { # <dir>: only a lock this process holds
  if [ "$(cat "$1/pid" 2>/dev/null || true)" = "$$" ]; then rm -rf "$1"; fi
}

acquire_test_lock() {
  local waited=0
  while ! try_lock "$test_lock"; do
    if [ $((waited % 30)) -eq 0 ]; then echo "docker-ci: another test job (process $(cat "$test_lock/pid" 2>/dev/null || echo unknown)) holds the PostgreSQL and collector services; waiting (${waited} s)"; fi
    sleep 5
    waited=$((waited + 5))
  done
  held_test=1
  if [ "$waited" -gt 0 ]; then echo "docker-ci: the test lock is mine after ${waited} s"; fi
}

# At most max_jobs job containers at once, across the worktrees: a slot is a lock directory.
acquire_slot() {
  local waited=0 i held
  while :; do
    for i in $(seq 1 "$max_jobs"); do
      if try_lock "$git_dir/mandate-ci-slot.$i"; then
        slot_dir="$git_dir/mandate-ci-slot.$i"
        if [ "$waited" -gt 0 ]; then echo "docker-ci: a place for this job after ${waited} s"; fi
        return 0
      fi
    done
    if [ $((waited % 30)) -eq 0 ]; then
      held="$(for i in $(seq 1 "$max_jobs"); do cat "$git_dir/mandate-ci-slot.$i/pid" 2>/dev/null; done | tr '\n' ' ')"
      echo "docker-ci: $max_jobs jobs are running already (processes ${held:-unknown}); waiting for a place (${waited} s)"
    fi
    sleep 5
    waited=$((waited + 5))
  done
}

# On exit, however it comes: the services and the test lock of a test job that holds them, and the slot. A job that was
# still waiting removes nothing that is another's.
cleanup_all() {
  if [ "$held_test" = 1 ]; then
    dc --profile services rm -sfv postgres otel-collector >/dev/null 2>&1 || true
    lock_release "$test_lock"
    held_test=0
  fi
  if [ -n "$slot_dir" ]; then lock_release "$slot_dir"; slot_dir=""; fi
}

job_container=""
on_signal() { # INT, TERM or HUP: the job container goes, and with it this script (its EXIT trap cleans up the rest)
  if [ -n "$job_container" ]; then rm_container "$job_container"; fi
  exit "$1"
}
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
trap 'on_signal 129' HUP
trap cleanup_all EXIT

# ── running a job ───────────────────────────────────────────────────────────────────────────────────────────────

# One boot.sh in a fresh container of the service, the commit's pack on its standard input. The values passed in are
# the two digests and, for quick, the Node release (validated here): nothing else of the host's environment.
# In the background and waited for, so that a signal to this script is handled at once (a trap waits for a foreground
# command to end) and removes the container by its name.
run_once() { # <service> <job> [command...]
  local service="$1" jobname="$2"
  shift 2
  local envs=(-e "MANDATE_CI_IMAGE=$image_digest" -e "MANDATE_CI_STEPS=$steps_digest")
  if [ -n "${MANDATE_CI_NODE:-}" ]; then
    case "$MANDATE_CI_NODE" in 22 | 24) envs+=(-e "MANDATE_CI_NODE=$MANDATE_CI_NODE") ;; *) die "MANDATE_CI_NODE must be 22 or 24" ;; esac
  fi
  job_container="mandate-ci-job-$$"
  ( set -o pipefail; pack_of_commit "$sha" | dc --profile run run --rm -T --no-deps --name "$job_container" "${envs[@]}" "$service" bash /usr/local/lib/mandate-ci/boot.sh "$jobname" "$sha" "$@" ) &
  local child=$!
  wait "$child"
  local rc=$?
  job_container=""
  return "$rc"
}

# boot.sh says with its status 97 (which a job cannot return: boot.sh turns it into 1) that the image is not the one this
# checkout built: another checkout built it under the same tag since. The image is built again and the job tried again,
# up to five times; a job never runs on another checkout's image.
run_in() { # <service> <job> [command...]
  local attempt rc=0
  for attempt in 1 2 3 4 5; do
    rc=0
    run_once "$@" || rc=$?
    if [ "$rc" -ne 97 ]; then return "$rc"; fi
    echo "docker-ci: the image holds another checkout's Dockerfile, .dockerignore, boot.sh or run-job.sh (attempt $attempt of 5); building it again"
    ensure_image
  done
  echo "docker-ci: the image was changed by another checkout each of five times; run the job again" >&2
  return 3
}

run_test_job() {
  local rc=0
  # Services left by a job that was killed.
  dc --profile services rm -sfv postgres otel-collector >/dev/null 2>&1 || true
  # This commit's collector configuration and an empty output directory, in the volumes the collector and the runner
  # share. (The runner image is used for the copy; the commit's file is read from the git objects on the host.)
  git -C "$root_native" cat-file blob "$sha:runtime/test/otel-collector.yaml" |
    dc --profile run run --rm -T --no-deps runner sh -c 'cat > /otel/config/config.yaml && rm -f /otel/out/spans.json' || return 1
  dc --profile services up -d --wait postgres otel-collector || rc=$?
  if [ "$rc" -eq 0 ]; then run_in runner test || rc=$?; fi
  if [ "$rc" -ne 0 ]; then
    echo "--- the collector's log (last 40 lines)"
    dc --profile services logs --no-color --tail 40 otel-collector 2>&1 || true
    echo "--- the collector's output file (first 2000 bytes)"
    dc --profile run run --rm -T --no-deps runner sh -c 'ls -l /otel/out; head -c 2000 /otel/out/spans.json' 2>&1 || true
  fi
  return "$rc"
}

# ── selfcheck ───────────────────────────────────────────────────────────────────────────────────────────────────

in_container() { # <container id>: the commit's pack into boot.sh of a running container, to run its selfcheck
  pack_of_commit "$sha" | docker exec -i -e "MANDATE_CI_IMAGE=$image_digest" -e "MANDATE_CI_STEPS=$steps_digest" "$1" bash /usr/local/lib/mandate-ci/boot.sh selfcheck "$sha"
}

cid="" cid2="" tmp="" ntmp=""
cleanup_selfcheck() {
  if [ -n "$cid" ]; then rm_container "$cid"; fi
  if [ -n "$cid2" ]; then rm_container "$cid2"; fi
  if [ -n "$tmp" ]; then rm -rf "$tmp"; fi
}

selfcheck() {
  resolve
  ensure_image
  fail=0
  ok() { echo "ok:   $*"; }
  bad() { echo "FAIL: $*"; fail=1; }
  trap cleanup_selfcheck EXIT

  # The container as Docker made it: nothing of the host in it, and exactly the grant of the service.
  inspect_container() { # <id> <name> <security_opt, sorted> <devices>
    local c="$1" name="$2" want_sec="$3" want_dev="$4" mounts got
    mounts="$(insp "$c" '{{range .Mounts}}{{.Type}} {{.Destination}}{{"\n"}}{{end}}')"
    if printf '%s\n' "$mounts" | grep -q '^bind '; then bad "$name: a bind mount: $(printf '%s\n' "$mounts" | grep '^bind ' | tr '\n' ' ')"; else ok "$name: no bind mount whatsoever"; fi
    if printf '%s\n' "$mounts" | grep -v '^volume ' | grep -q .; then bad "$name: a mount that is not a named volume: $(printf '%s\n' "$mounts" | grep -v '^volume ' | tr '\n' ' ')"; else ok "$name: every mount is a named volume ($(printf '%s\n' "$mounts" | grep -c .) of them)"; fi
    if [ "$(insp "$c" '{{.HostConfig.Privileged}}')" = false ]; then ok "$name: not privileged"; else bad "$name: privileged"; fi
    if [ "$(insp "$c" '{{.HostConfig.NetworkMode}}')" != host ]; then ok "$name: not on the host network"; else bad "$name: host network"; fi
    if [ -z "$(insp "$c" '{{.HostConfig.PidMode}}')" ] && [ -z "$(insp "$c" '{{.HostConfig.UTSMode}}')" ] && [ -z "$(insp "$c" '{{.HostConfig.UsernsMode}}')" ] && [ "$(insp "$c" '{{.HostConfig.IpcMode}}')" != host ]; then ok "$name: no host PID, UTS, IPC or user namespace"; else bad "$name: a host namespace"; fi
    case "$(insp "$c" '{{json .HostConfig.PortBindings}}')" in '{}' | null) ok "$name: no published port" ;; *) bad "$name: a published port" ;; esac
    case "$(insp "$c" '{{json .HostConfig.CapAdd}}')" in null | '[]') ok "$name: no capability added" ;; *) bad "$name: CapAdd is $(insp "$c" '{{json .HostConfig.CapAdd}}')" ;; esac
    if [ "$(insp "$c" '{{json .HostConfig.CapDrop}}')" = '["ALL"]' ]; then ok "$name: every capability dropped"; else bad "$name: CapDrop is $(insp "$c" '{{json .HostConfig.CapDrop}}')"; fi
    got="$(insp "$c" '{{range .HostConfig.SecurityOpt}}{{.}}{{"\n"}}{{end}}' | grep . | sort | tr '\n' ' ' | sed 's/ $//')"
    if [ "$got" = "$want_sec" ]; then ok "$name: security options are exactly: $got"; else bad "$name: security options are '$got', not '$want_sec'"; fi
    got="$(insp "$c" '{{range .HostConfig.Devices}}{{.PathOnHost}}->{{.PathInContainer}}{{"\n"}}{{end}}' | grep . | tr '\n' ' ' | sed 's/ $//')"
    if [ "$got" = "$want_dev" ]; then ok "$name: devices are exactly: ${got:-none}"; else bad "$name: devices are '$got', not '$want_dev'"; fi
  }

  echo "--- the runner container, as Docker made it"
  cid="$(dc --profile run run -d -T --no-deps runner sleep 900 | tail -n 1)" || die "could not start the runner container"
  inspect_container "$cid" runner "no-new-privileges:true" ""
  echo "--- inside the runner container, on the pack of $sha"
  in_container "$cid" || fail=1
  rm_container "$cid"
  cid=""

  echo "--- the sandbox container, as Docker made it"
  cid2="$(dc --profile run run -d -T --no-deps runner-sandbox sleep 900 | tail -n 1)" || die "could not start the sandbox container"
  inspect_container "$cid2" runner-sandbox "no-new-privileges:true seccomp=unconfined" "/dev/net/tun->/dev/net/tun"
  echo "--- inside the sandbox container, on the pack of $sha"
  in_container "$cid2" || fail=1
  rm_container "$cid2"
  cid2=""

  echo "--- a dotenv file in the current directory does not reach a container"
  tmp="$(mktemp -d)"
  printf 'MANDATE_DECOY_PROBE=made-up-plain-words\n' >"$tmp/.env"
  cat >"$tmp/probe.yml" <<'EOF'
services:
  runner:
    environment:
      DECOY_PROBE: ${MANDATE_DECOY_PROBE:-absent}
EOF
  ntmp="$(native "$tmp")"
  # The control: compose read in the way this script does not read it (project directory = the directory with the dotenv
  # file) does load the file, so that the test below could fail.
  if control_loads_dotenv; then
    ok "control: compose does load the dotenv file of its project directory (the decoy shows in the resolved file)"
  else
    bad "control: the decoy did not show with the project directory beside it, so the test below proves nothing"
  fi
  # The real invocation, run from that directory.
  local out
  out="$(cd "$tmp" && dcp "$ntmp/probe.yml" --profile run run --rm -T --no-deps runner sh -c 'printenv DECOY_PROBE; env | cut -d= -f1 | grep -c "^MANDATE_DECOY" || true' 2>/dev/null)"
  if [ "$(printf '%s\n' "$out" | sed -n 1p)" = absent ] && [ "$(printf '%s\n' "$out" | sed -n 2p)" = 0 ]; then
    ok "the decoy variable from the dotenv file does not reach the container (DECOY_PROBE=absent, no MANDATE_DECOY* in the environment)"
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
    if [ "$job" = test ] && ! git -C "$root_native" cat-file -e "$sha:runtime/test/otel-collector.yaml" 2>/dev/null; then
      die "the commit $sha has no runtime/test/otel-collector.yaml, which the test job needs: nothing was started"
    fi
    ensure_image
    # The test job takes the test lock first (a waiting test job holds no place), then a place among the running jobs.
    if [ "$job" = test ]; then acquire_test_lock; fi
    acquire_slot
    echo "docker-ci: $job on commit $sha"
    rc=0
    note=""
    case "$job" in
      test) run_test_job || rc=$? ;;
      sandbox)
        run_in runner-sandbox sandbox || rc=$?
        note=" (CI only, not run here: the container sandbox host on a real Docker engine, the Ubuntu 22.04 kernel, sandbox-windows)"
        ;;
      quick) run_in runner quick "${cmd[@]}" || rc=$? ;;
      *) run_in runner "$job" || rc=$? ;;
    esac
    finish "$job $sha$note" "$rc"
    ;;
  *) usage ;;
esac
