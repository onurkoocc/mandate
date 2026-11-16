#!/bin/bash
# The fixed entry of the job container (in the image, run by scripts/docker-ci.sh):
#
#   boot.sh <job> <commit sha> <tree id> [command...]
#
# The commit under test arrives as a tar archive on the standard input (`git archive` on the host): nothing of the host's
# file system or git directory is mounted. This script extracts it into /ci/repo, makes a git repository of it with one
# commit under a fixed identity (so that `git status` and `git diff` work for the steps that use them; CI's own checkout
# is depth 1 too, and no step reads history), checks that the commit's tree is the commit under test's tree, and runs
# the job steps of the tested commit (its own docker/run-job.sh) or, for a commit from before docker/ existed, the copy
# that is baked into the image. It says which.
set -eu

job="${1:?usage: boot.sh <job> <sha> <tree> [command...]}"
sha="${2:?usage: boot.sh <job> <sha> <tree> [command...]}"
tree="${3:?usage: boot.sh <job> <sha> <tree> [command...]}"
shift 3

lib=/usr/local/lib/mandate-ci

# The host passes the digest of the boot.sh and run-job.sh it holds; the image must hold the same ones. Two checkouts
# that build the image under the same tag would otherwise run each other's steps unseen.
if [ -n "${MANDATE_CI_CONTEXT:-}" ]; then
  have="$(cat "$lib/boot.sh" "$lib/run-job.sh" | sha256sum | cut -d' ' -f1)"
  if [ "$have" != "$MANDATE_CI_CONTEXT" ]; then
    echo "boot: the image holds other boot.sh and run-job.sh than the checkout that started it (another checkout built the image since); run it again" >&2
    exit 3
  fi
fi

cd /ci/repo
tar -x -f -
git init -q .
git add -A -f
git -c user.name=mandate-ci -c user.email=mandate-ci@localhost -c commit.gpgsign=false commit -q -m "the tree of $sha"
got="$(git rev-parse 'HEAD^{tree}')"
if [ "$got" != "$tree" ]; then
  echo "boot: the clone's tree is $got, the tree of $sha is $tree: the archive did not give the commit's files" >&2
  exit 3
fi
echo "tested commit: $sha"
echo "the clone in /ci/repo has one commit, $(git rev-parse HEAD), whose id is not the tested commit's (its tree is)"

if [ -f docker/run-job.sh ]; then
  echo "steps: docker/run-job.sh of the tested commit"
  steps=/ci/repo/docker/run-job.sh
else
  echo "steps: the copy baked into the image (the tested commit has no docker/run-job.sh)"
  steps="$lib/run-job.sh"
fi
exec bash "$steps" "$job" "$sha" "$@"
