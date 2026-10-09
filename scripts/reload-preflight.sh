#!/usr/bin/env bash
# The refusals `make reload` makes BEFORE it touches the running server: tracked/installed plist
# drift (file compare and launchd's live ExitTimeOut) and running jobs without FORCE=1.
#
# Exit 0 = clear to reload. Exit 3 = REFUSED (nothing was drained or killed; the reason is
# printed). Own script, not Makefile recipe lines, because make collapses every recipe failure
# to its own exit 2 — scripts/deploy.sh runs this directly so it can tell "refused, the old
# server is still running" (no rollback) from a post-restart failure (rollback).
# Run from the repo root (make and deploy.sh both do).
set -uo pipefail

REFUSED=3

# Pre-rename install: the old-named agent is still the loaded one, its plist points at scripts that
# no longer exist, so a reload would drain it and KeepAlive could never respawn it.
for old in com.jkrumm.sideclaw-server com.jkrumm.sideclaw; do
  if launchctl print "gui/$(id -u)/$old" >/dev/null 2>&1; then
    echo "refusing to reload: the pre-rename LaunchAgent $old is still loaded — run scripts/migrate-runtime.sh (drains it, moves data, installs com.jkrumm.agent-gateway) first."
    exit "$REFUSED"
  fi
done

tracked="com.jkrumm.agent-gateway.plist"
installed="$HOME/Library/LaunchAgents/com.jkrumm.agent-gateway.plist"
if [ -f "$installed" ]; then
  tracked_json=$(plutil -convert json -o - "$tracked" 2>/dev/null)
  installed_json=$(plutil -convert json -o - "$installed" 2>/dev/null)
  if [ -n "$tracked_json" ] && [ "$tracked_json" != "$installed_json" ]; then
    echo "refusing to reload: $tracked differs from the plist launchd has loaded ($installed) — 'make reload' only signals the running job, it never re-reads the plist. Run 'make install-agent' first, then 'make reload'."
    exit "$REFUSED"
  fi
fi

tracked_exit=$(grep -A1 '<key>ExitTimeOut</key>' "$tracked" | grep -o '[0-9]\+')
live_exit=$(launchctl print "gui/$(id -u)/com.jkrumm.agent-gateway" 2>/dev/null | awk -F'= ' '/exit timeout = /{print $2; exit}')
if [ -n "$tracked_exit" ] && [ -n "$live_exit" ] && [ "$tracked_exit" != "$live_exit" ]; then
  echo "refusing to reload: launchd's LIVE ExitTimeOut (${live_exit}s) does not match the tracked plist (${tracked_exit}s) — 'launchctl bootstrap' never took (the file compare above cannot see this: see the comment above the Makefile's reload target). Run 'make install-agent' first, then 'make reload'."
  exit "$REFUSED"
fi

if [ -z "${FORCE:-}" ]; then
  n=$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0)
  if [ "${n:-0}" != "0" ]; then
    echo "refusing to reload: $n job(s) running — waiting is normal (jobs commonly run minutes), or FORCE=1 make reload discards them"
    exit "$REFUSED"
  fi
fi
exit 0
