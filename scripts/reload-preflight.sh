#!/usr/bin/env bash
# The refusals `make reload` makes BEFORE it touches the running server: tracked/installed plist
# drift (file compare and launchd's live ExitTimeOut) and running jobs the reload cannot detach
# (OpenCode sessions can be, so they never refuse) without FORCE=1.
#
# Exit 0 = clear to reload. Exit 3 = REFUSED (nothing was drained or killed; the reason is
# printed). Own script, not Makefile recipe lines, because make collapses every recipe failure
# to its own exit 2 — scripts/deploy.sh runs this directly so it can tell "refused, the old
# server is still running" (no rollback) from a post-restart failure (rollback).
# Run from the repo root (make and deploy.sh both do).
set -uo pipefail

REFUSED=3

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
  # Only jobs a reload would WAIT for or discard count: `drainBlockers` excludes a job whose live
  # work is an OpenCode session — the drain detaches those at its start and the next boot
  # re-attaches them. Single-shot jobs (triage/decide, seconds long, requeued on boot) were never
  # a reason to refuse and still are not; the drain itself does wait for them. An older server
  # without the field falls back to every running session-lane job.
  n=$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r 'if .drainBlockers != null then .drainBlockers - (.singleShot.running // 0) else (.running // 0) end' 2>/dev/null || echo 0)
  if [ "${n:-0}" != "0" ]; then
    echo "refusing to reload: $n job(s) running that a reload cannot detach (claude -p sessions, check steps) — waiting is normal (jobs commonly run minutes), or FORCE=1 make reload discards them. OpenCode sessions are not counted: they survive a reload."
    exit "$REFUSED"
  fi
fi
exit 0
