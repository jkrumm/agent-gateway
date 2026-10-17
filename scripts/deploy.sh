#!/usr/bin/env bash
# Ships the checked-out HEAD: `make reload` (self-drain + restart), then `make verify`.
# On a failed verify (reload succeeded, the new server is unhealthy), rolls the checkout back to
# HEAD~1 (detached) and reloads again — only when the working tree is clean; otherwise it refuses
# and says how to recover by hand. A REFUSED reload (running jobs, plist drift) never rolls back:
# the old server was not touched, so the refusal's own message is the reason; exit 1. Refusals are
# detected by running scripts/reload-preflight.sh (exit 3) first — make collapses its own failures
# to exit 2, so the code cannot be read off `make reload`. Any other reload failure happens after
# the old server was drained/killed, so it takes the same rollback path as a failed verify.
# FORCE=1 is passed through to every reload (running jobs otherwise make reload refuse).
# WAIT=1 is passed through likewise: the reload drains (new jobs queue as pending) instead of refusing.
# Before the reload it also makes sure the shared OpenCode server's LaunchAgent is loaded
# (verify fails without it) — installing it only when ABSENT, never restarting a loaded one: a
# restart would kill the episodes attached to it. A failed install, or a server that is not ok
# afterwards (down, wrong password, not the pinned opencode), aborts before the reload with
# nothing touched and no rollback. Likewise a post-reload verify that fails ONLY on the opencode
# server is reported as an opencode problem and does not roll back master: the build is not at fault.
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

ensure_opencode_agent() {
  local label="com.jkrumm.agent-gateway-opencode"
  local plist="$label.plist" installed="$HOME/Library/LaunchAgents/$label.plist"
  if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
    if [ -f "$plist" ] && [ -f "$installed" ] && ! cmp -s "$plist" "$installed"; then
      echo "note: the installed $label plist differs from the tracked one — 'make install-opencode-agent' applies it (restarts the server; refuses while jobs run)"
    fi
    return 0
  fi
  echo "$label is not loaded — installing"
  make --no-print-directory install-opencode-agent
}

# The opencode server's own status, independent of the (old) agent-gateway build: the JSON
# `getOpencodeServerStatus()` printed by the env script. Retried while a fresh install settles.
opencode_server_ok() {
  local n out
  for n in 1 2 3; do
    out="$(bun scripts/opencode-server-env.ts --status 2>/dev/null)" || out=""
    if jq -e '.ok == true' <<<"$out" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  OPENCODE_STATUS_OUT="$out"
  return 1
}

# True when the NEW build's job health shows a healthy queue and only the opencode server not ok.
opencode_only_failure() {
  local body
  body="$(curl -sf --max-time 5 http://127.0.0.1:7705/api/jobs/health)" || return 1
  jq -e '.ok == true and (.degradedRoutes | length == 0) and (.opencodeServer.ok == false)' <<<"$body" >/dev/null 2>&1
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
if ! ensure_opencode_agent; then
  echo "deploy of $head FAILED: the opencode LaunchAgent could not be installed — the agent-gateway server was not touched, not rolling back"
  exit 1
fi
if ! opencode_server_ok; then
  echo "deploy of $head ABORTED: the opencode server is not ok — the agent-gateway server was not touched, not rolling back"
  echo "  status: ${OPENCODE_STATUS_OUT:-unreachable}"
  echo "  fix: make install-opencode-agent (refuses while jobs run) · the pinned build under ~/.local/share/agent-gateway/opencode-bin/<version> (OPENCODE_PINNED_VERSION in server/mcp/opencode-server.ts) · tail ~/Library/Logs/agent-gateway-opencode.err"
  exit 1
fi
if make --no-print-directory reload; then
  if verify_with_retry; then
    echo "deployed $head and verified"
    exit 0
  fi
  if opencode_only_failure; then
    echo "deploy of $head: reloaded, but verify fails ONLY on the opencode server — not a build regression, NOT rolling back"
    echo "  fix: make install-opencode-agent · the pinned build (docs/opencode-v2.md) · tail ~/Library/Logs/agent-gateway-opencode.err, then make verify"
    exit 1
  fi
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
