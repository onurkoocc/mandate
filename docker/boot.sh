#!/bin/bash
# The fixed entry of the job container (in the image, run by scripts/docker-ci.sh):
#
#   boot.sh <job> <commit sha> [command...]
#
# The commit under test arrives on the standard input as a pack of exactly that commit, its trees and its blobs
# (`git rev-list --objects --no-walk | git pack-objects --stdout` on the host: nothing of the host's working tree, git
# directory, configuration or filters is involved, and no conversion is made on the host). This script makes the
# checkout the way CI's actions/checkout does: an empty repository, the objects unpacked, the repository marked shallow
# at the commit, and a detached checkout of the commit made by the container's own git. HEAD is the real commit id.
# It then runs the job steps of the tested commit (its own docker/run-job.sh) or, for a commit from before docker/
# existed, the copy that is baked into the image, and says which.
#
# The checkout is made the way CI's actions/checkout makes a depth-1 one in its result (the tree of the commit, shallow),
# not in every detail: HEAD is detached, there is no origin remote, and git is the image's (2.43).
#
# The image is the one this checkout built: the host passes the digest of the Dockerfile, .dockerignore and boot.sh it
# holds, and the image holds copies of them. When they differ (another checkout rebuilt the image under the same tag
# since), the status is 97, and the script rebuilds and tries again; no job runs on another checkout's image. A job's
# own status 97 is reported as 1, so that 97 means this and nothing else.
set -eu

job="${1:?usage: boot.sh <job> <sha> [command...]}"
sha="${2:?usage: boot.sh <job> <sha> [command...]}"
shift 2

lib=/usr/local/lib/mandate-ci
sum() { sha256sum | cut -d' ' -f1; }

if [ -z "${MANDATE_CI_IMAGE:-}" ]; then
  echo "boot: this image was built by a newer checkout of the Docker scripts; run the job again (your checkout rebuilds its own image)" >&2
  exit 97
fi
have="$(cat "$lib/Dockerfile" "$lib/.dockerignore" "$lib/boot.sh" | sum)"
if [ "$have" != "$MANDATE_CI_IMAGE" ]; then
  echo "boot: the image was built from another Dockerfile, .dockerignore or boot.sh than the checkout that started it" >&2
  exit 97
fi

cd /ci/repo
git init -q -b main .
echo "$sha" > .git/shallow
git unpack-objects --strict -q
git checkout -q --detach "$sha"
if [ "$(git rev-parse HEAD)" != "$sha" ]; then echo "boot: HEAD is not the tested commit $sha" >&2; exit 3; fi
status="$(git status --porcelain)"
if [ -n "$status" ]; then echo "boot: the checkout of $sha is not clean:" >&2; echo "$status" >&2; exit 3; fi
git fsck --connectivity-only --no-dangling
echo "tested commit: $sha (a depth-1 checkout of its own objects, made in the container)"

if [ -f docker/run-job.sh ]; then
  echo "steps: docker/run-job.sh of the tested commit"
  steps=/ci/repo/docker/run-job.sh
else
  # The copy in the image must be the one of the checkout that started this.
  if [ "$(sum < "$lib/run-job.sh")" != "${MANDATE_CI_STEPS:-}" ]; then
    echo "boot: the image holds another run-job.sh than the checkout that started it, and the tested commit has none" >&2
    exit 97
  fi
  echo "steps: the copy baked into the image (the tested commit has no docker/run-job.sh)"
  steps="$lib/run-job.sh"
fi
rc=0
bash "$steps" "$job" "$sha" "$@" || rc=$?
if [ "$rc" -eq 97 ]; then rc=1; fi
exit "$rc"
