#!/bin/bash
# LaunchAgent entrypoint. This wrapper exists for exactly one reason, and it is
# not convenience — removing it silently breaks auto-start at boot.
#
# macOS Background Task Management (Ventura+) computes an EFFECTIVE disposition
# for every launch item from the item's executable, not from the plist. On this
# host `/opt/homebrew/bin/bun` is denied: an item registers with a stored
# disposition of [enabled, allowed], and BTM immediately resolves it to
# [enabled, disallowed]. Measured 2026-08-06 with a throwaway agent whose only
# job was `bun --version` — brand new label, never seen before, disallowed on
# registration. The same probe pointed at a shell script that execs the same bun
# resolved to [enabled, allowed].
#
# The consequence is not a hard failure, which is what made it hard to see:
# launchd skips the RunAtLoad spawn and KeepAlive picks the job up later, or
# not at all. Across three reboots on 2026-08-06: no start in one, +3m06s and
# +3m42s in the other two, against ~18s for every allowed agent on the machine.
# A dead MCP offload lane after a power cut reads as "sideclaw is broken", not
# as a login-item toggle.
#
# BTM identifies a script by path, so this file's location is part of the fix —
# moving it re-registers a new item. `com.jkrumm.linewatch-collector` was the
# only other direct-bun agent here and had the identical defect.
set -euo pipefail
cd "$(dirname "$0")/.."
# Max-lane workers (`claude -p`) authenticate with the long-lived OAuth token, not the
# login keychain's refreshable credential: a launchd process and interactive sessions
# refreshing the same credential rotate its refresh token under each other, and the
# daemon loses ("OAuth session expired and could not be refreshed", 2026-10-03..05).
# session-runner keeps CLAUDE_CODE_OAUTH_TOKEN in the worker env (ALWAYS_KEEP_ENV).
# Fail-soft: no token → workers fall back to the keychain as before.
if [ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" ] && command -v "$HOME/.local/bin/secrets-run" >/dev/null; then
  token="$("$HOME/.local/bin/secrets-run" read op://mini/claude/oauth-token 2>/dev/null || true)"
  [ -n "$token" ] && export CLAUDE_CODE_OAUTH_TOKEN="$token"
  unset token
fi
exec /opt/homebrew/bin/bun server/index.ts
