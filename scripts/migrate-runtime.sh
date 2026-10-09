#!/usr/bin/env bash
# One-time runtime migration for the sideclaw → agent-gateway rename (2026-10-09).
# Idempotent: every step skips what is already done. Run from the repo root AFTER the rename
# commit is checked out, with the old agent still serving (it is drained, not killed):
#
#   scripts/migrate-runtime.sh
#
# 1. drains + stops the old `com.jkrumm.sideclaw-server` agent (refuses while jobs run, FORCE=1
#    discards them), 2. moves data/state/log paths to the agent-gateway names, 3. installs the NEW
#    label via `make install-agent` (never reuses a burned label), 4. verifies health.
set -euo pipefail
cd "$(dirname "$0")/.."

OLD_LABEL=com.jkrumm.sideclaw-server
UID_=$(id -u)

if [ -z "${FORCE:-}" ]; then
  n=$(curl -sf --max-time 3 http://127.0.0.1:7705/api/jobs/health 2>/dev/null | jq -r '.running // 0' 2>/dev/null || echo 0)
  if [ "${n:-0}" != "0" ]; then
    echo "refusing: $n job(s) running — wait, or FORCE=1 scripts/migrate-runtime.sh discards them" >&2
    exit 1
  fi
fi

if launchctl print "gui/$UID_/$OLD_LABEL" >/dev/null 2>&1; then
  old=$(launchctl print "gui/$UID_/$OLD_LABEL" | awk '/^[[:space:]]*pid = /{print $3; exit}')
  # Self-initiated drain (same path as `make reload`), then unload so KeepAlive cannot respawn it.
  curl -sf --max-time 3 -X POST -H "X-Sideclaw-Shutdown: 1" -H "X-Agent-Gateway-Shutdown: 1" \
    "http://127.0.0.1:7705/api/shutdown${FORCE:+?force=1}" >/dev/null 2>&1 || true
  launchctl bootout "gui/$UID_/$OLD_LABEL" 2>/dev/null || true
  while [ -n "${old:-}" ] && kill -0 "$old" 2>/dev/null; do sleep 0.5; done
fi
rm -f "$HOME/Library/LaunchAgents/$OLD_LABEL.plist"

mv_if() { # mv_if <from> <to>: skip when from is gone, refuse to clobber an existing target
  [ -e "$1" ] || return 0
  [ ! -e "$2" ] || { echo "skip: $2 already exists (left $1 in place)" >&2; return 0; }
  mkdir -p "$(dirname "$2")"
  mv "$1" "$2"
  echo "moved $1 -> $2"
}

share="$HOME/.local/share" state="$HOME/.local/state" logs="$HOME/Library/Logs"
mv_if "$share/sideclaw" "$share/agent-gateway"
mv_if "$share/agent-gateway/sideclaw.db" "$share/agent-gateway/agent-gateway.db"
mv_if "$state/sideclaw" "$state/agent-gateway"
for ext in log err jsonl; do mv_if "$logs/sideclaw.$ext" "$logs/agent-gateway.$ext"; done

make install-agent
make install-cli
make verify
