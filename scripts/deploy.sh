#!/usr/bin/env bash
# Ships the checked-out HEAD: `make reload` (build + self-drain + restart), then `make verify`.
# On a failed verify (reload succeeded, the new server is unhealthy), rolls the checkout back to
# HEAD~1 (detached) and reloads again — only when the working tree is clean; otherwise it refuses
# and says how to recover by hand. A REFUSED reload (running jobs, plist drift) never rolls back:
# the old server was not touched, so the refusal's own message is the reason; exit 1. Refusals are
# detected by running scripts/reload-preflight.sh (exit 3) first — make collapses its own failures
# to exit 2, so the code cannot be read off `make reload`. Any other reload failure happens after
# the old server was drained/killed, so it takes the same rollback path as a failed verify.
# FORCE=1 is passed through to every reload (running jobs otherwise make reload refuse).
set -uo pipefail
cd "$(dirname "$0")/.."

prev=$(git rev-parse --verify --quiet HEAD~1) || prev=""
head=$(git rev-parse --short HEAD)

verify_with_retry() {
  # The server needs a few seconds after boot before its job-health payload settles.
  local n
  for n in 1 2 3 4 5; do
    make --no-print-directory verify && return 0
    sleep 3
  done
  return 1
}

echo "deploying $head"
scripts/reload-preflight.sh
rc=$?
if [ "$rc" -eq 3 ]; then
  echo "deploy of $head REFUSED (see above) — the running server was not touched, not rolling back"
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  echo "deploy of $head FAILED: reload preflight errored (exit $rc) — not rolling back"
  exit 1
fi
if make --no-print-directory reload && verify_with_retry; then
  echo "deployed $head and verified"
  exit 0
fi

echo "deploy of $head FAILED (reload or verify)"
if [ -z "$prev" ]; then
  echo "no previous commit to roll back to"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "refusing to roll back: working tree is not clean. Commit/stash, then 'git switch --detach $prev && make reload'."
  exit 1
fi

echo "rolling back to $(git rev-parse --short "$prev")"
git switch --detach "$prev" || exit 1
if make --no-print-directory reload && verify_with_retry; then
  echo "################################################################"
  echo "ROLLED BACK: the checkout is now DETACHED at $(git rev-parse --short "$prev") (deploy of $head failed)."
  echo "Fix forward, then return with: git switch master"
  echo "################################################################"
else
  echo "################################################################"
  echo "ROLLBACK ALSO FAILED. Checkout is DETACHED at $(git rev-parse --short "$prev"). Inspect: make logs"
  echo "Return with: git switch master"
  echo "################################################################"
fi
exit 1
