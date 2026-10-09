#!/usr/bin/env bash
# The Gate 3 acceptance run (BACKLOG P1-10): FixBug's five agents on Opus 5.5,
# each in its own Bubblewrap sandbox, against the test repository, in a
# privileged Linux container (Bubblewrap needs user namespaces).
#
#   examples/fixbug-target/gate3.sh start     build the container, check out the seed, start the run
#   examples/fixbug-target/gate3.sh mandate status gate3-1
#   examples/fixbug-target/gate3.sh mandate approve gate3-1 --revision N --by <you>
#   examples/fixbug-target/gate3.sh stop      remove the container
#
# Secrets come from the environment or the repository's .env: CLAUDE_API_KEY,
# CLAUDE_WORKSPACE_ID (or anthropic-workspace-id) and MANDATE_GITHUB_TOKEN.
# They are passed to the runtime process only; the agents' sandboxes start
# with an empty environment, and the clone keeps no token.

set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(cd "$here/../.." && pwd)"
name="mandate-gate3"
run_id="${RUN_ID:-gate3-1}"

secret() {
  local key="$1" value="${!1:-}"
  if [ -z "$value" ] && [ -f "$root/.env" ]; then value="$(grep -E "^$2=" "$root/.env" | head -n1 | cut -d= -f2- || true)"; fi
  printf '%s' "$value"
}

case "${1:-}" in
  start)
    api="$(secret CLAUDE_API_KEY CLAUDE_API_KEY)"
    ws="$(secret CLAUDE_WORKSPACE_ID 'anthropic-workspace-id')"
    gh="$(secret MANDATE_GITHUB_TOKEN MANDATE_GITHUB_TOKEN)"
    [ -n "$api" ] || { echo "CLAUDE_API_KEY is not set" >&2; exit 2; }
    [ -n "$gh" ] || { echo "MANDATE_GITHUB_TOKEN is not set" >&2; exit 2; }
    docker rm -f "$name" >/dev/null 2>&1 || true
    MSYS_NO_PATHCONV=1 docker run -d --name "$name" --privileged \
      -e CLAUDE_API_KEY="$api" -e CLAUDE_WORKSPACE_ID="$ws" -e MANDATE_GITHUB_TOKEN="$gh" \
      -v "$root:/src:ro" node:24-bookworm sleep infinity >/dev/null
    MSYS_NO_PATHCONV=1 docker exec "$name" bash -ec '
      apt-get update -qq >/dev/null && apt-get install -y -qq bubblewrap git rsync >/dev/null
      mkdir -p /m && rsync -a --exclude node_modules --exclude dist --exclude .env --exclude .mandate /src/ /m/
      cd /m && npm ci --no-audit --no-fund >/tmp/npm.log 2>&1 && npm run build >/tmp/build.log 2>&1
      printf "#!/bin/sh\nexec node /m/compiler/dist/cli.js \"\$@\"\n" > /usr/local/bin/mandate && chmod +x /usr/local/bin/mandate
      # The token is sent as a header for this clone only; nothing in /work/repo keeps it.
      git -c http.extraHeader="Authorization: Basic $(printf "x-access-token:%s" "$MANDATE_GITHUB_TOKEN" | base64 -w0)" \
        clone -q https://github.com/onurkoocc/mandate-fixbug-target.git /work/repo
      git -C /work/repo checkout -q seed
      ! grep -rq "$MANDATE_GITHUB_TOKEN" /work/repo/.git || { echo "the token leaked into the clone" >&2; exit 1; }
    '
    MSYS_NO_PATHCONV=1 docker exec -w /m/examples/fixbug-target "$name" \
      mandate run fixbug.mdt --workflow FixBug --input issue.json --run-id "$run_id" --limit spend=20USD
    ;;
  mandate)
    shift
    MSYS_NO_PATHCONV=1 docker exec -w /m/examples/fixbug-target "$name" mandate "$@"
    ;;
  stop)
    docker rm -f "$name" >/dev/null
    ;;
  *)
    sed -n '2,13p' "$0" >&2
    exit 2
    ;;
esac
