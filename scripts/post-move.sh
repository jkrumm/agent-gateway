#!/usr/bin/env bash
# Run ONCE from ~/SourceRoot/agent-gateway after `mv ~/SourceRoot/sideclaw ~/SourceRoot/agent-gateway`
# (the sideclaw → agent-gateway rename, 2026-10-09). Idempotent. Steps:
#   1. Claude Code state keyed by the old directory: ~/.claude.json project entry + the
#      ~/.claude/projects/<slug> dir (memory, transcripts) follow the new path.
#   2. MCP registration (user scope) + `agw` CLI + deprecated `sideclaw` shim, via dotfiles' setup target.
#   3. Runtime: drain + stop the old LaunchAgent, move data/state/logs, install the NEW label, verify.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$(basename "$PWD")" = agent-gateway ] || { echo "run from the moved checkout (~/SourceRoot/agent-gateway)" >&2; exit 1; }

old=/Users/jkrumm/SourceRoot/sideclaw new=/Users/jkrumm/SourceRoot/agent-gateway
cj="$HOME/.claude.json"
if jq -e --arg o "$old" '.projects[$o]' "$cj" >/dev/null 2>&1; then
  cp "$cj" "$cj.pre-agent-gateway"
  tmp=$(mktemp)
  jq --arg o "$old" --arg n "$new" '.projects[$n] = (.projects[$n] // .projects[$o]) | del(.projects[$o])' "$cj" >"$tmp" && mv "$tmp" "$cj"
  echo "~/.claude.json: project $old -> $new (backup: $cj.pre-agent-gateway)"
fi
pold="$HOME/.claude/projects/-Users-jkrumm-SourceRoot-sideclaw" pnew="$HOME/.claude/projects/-Users-jkrumm-SourceRoot-agent-gateway"
if [ -d "$pold" ] && [ ! -e "$pnew" ]; then mv "$pold" "$pnew" && echo "moved $pold -> $pnew"; fi

make -C "$HOME/SourceRoot/dotfiles" _setup-agent-gateway
scripts/migrate-runtime.sh
