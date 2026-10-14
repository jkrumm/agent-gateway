#!/bin/bash
# LaunchAgent entrypoint of the shared OpenCode v2 server (com.jkrumm.agent-gateway-opencode).
# A shell wrapper for the same reason as scripts/agent-gateway-start.sh: macOS Background Task
# Management resolves a launch item's effective disposition from its EXECUTABLE, and bun (which
# builds this server's environment) is denied on this host — a direct-bun agent registers
# [enabled, allowed] and is immediately downgraded to [enabled, disallowed], so launchd skips
# RunAtLoad. A script that runs bun as a child resolved to [enabled, allowed]. Full argument:
# scripts/agent-gateway-start.sh and docs/deployment.md § The BTM denial. BTM identifies a
# script by path, so moving this file re-registers a new item.
#
# What this wrapper adds on top:
#   1. Refuses to start (exit 1, stderr, KeepAlive then retries on its throttle) unless
#      `opencode --version` is the pinned build — the 2026-10-11 `brew upgrade` changed behaviour
#      under a running agw and broke every dispatch (docs/opencode-v2.md § Version pin).
#   2. Launches `opencode serve` with a SCRUBBED environment (`env -i`): only PATH, HOME, TMPDIR,
#      LANG plus the variables scripts/opencode-server-env.ts names. Every worker shell on this
#      server inherits this env (a client cannot add to it), so agw's own tokens — CLAUDE_*,
#      GITHUB_TOKEN, … — must never be in it.
set -euo pipefail
cd "$(dirname "$0")/.."

# Captured before the eval so a failing bun (e.g. Keychain unavailable) stops the script
# instead of being swallowed inside `eval "$(…)"`.
server_env="$(/opt/homebrew/bin/bun scripts/opencode-server-env.ts)"
eval "$server_env"
unset server_env

bin="$(command -v opencode || true)"
if [ -z "$bin" ]; then
  echo "agent-gateway-opencode: opencode not found on PATH ($PATH)" >&2
  exit 1
fi
raw_version="$("$bin" --version 2>/dev/null || true)"
version="${raw_version##* }"
version="${version#v}"
if [ "$version" != "$AGW_OPENCODE_PINNED_VERSION" ]; then
  echo "agent-gateway-opencode: refusing to start: $bin is '${raw_version:-unknown}', pinned is $AGW_OPENCODE_PINNED_VERSION (brew pin opencode; upgrade gate in docs/opencode-v2.md)" >&2
  exit 1
fi

args=(
  "PATH=$PATH"
  "HOME=$HOME"
  "TMPDIR=${TMPDIR:-/tmp}"
  "LANG=${LANG:-en_US.UTF-8}"
)
for name in $AGW_OPENCODE_ENV_NAMES; do
  args+=("$name=${!name}")
done

# Server cwd: the state root, not the repo — a repo-local opencode.json must never be discovered
# from the server's own working directory.
cd "$AGW_OPENCODE_STATE_ROOT"
exec env -i "${args[@]}" "$bin" serve --hostname 127.0.0.1 --port "$AGW_OPENCODE_PORT"
