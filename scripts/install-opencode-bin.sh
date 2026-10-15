#!/bin/bash
# Idempotent: installs the pinned opencode build (OPENCODE_PINNED_VERSION) from npm under
# ~/.local/share/agent-gateway/opencode-bin/<version>, where scripts/agent-gateway-opencode-start.sh
# looks for it. Homebrew's bottle lags the npm releases, so Homebrew cannot serve the pin.
set -euo pipefail
cd "$(dirname "$0")/.."
version="$(/opt/homebrew/bin/bun -e 'import { OPENCODE_PINNED_VERSION as v } from "./server/mcp/opencode-server.ts"; console.log(v)')"
dir="$HOME/.local/share/agent-gateway/opencode-bin/$version"
bin="$dir/node_modules/.bin/opencode"
# `current` is what scripts/opencode (the machine-wide shim) execs.
link_current() { ln -sfn "$dir" "$HOME/.local/share/agent-gateway/opencode-bin/current"; }
if [ -x "$bin" ] && [ "$("$bin" --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//')" = "$version" ]; then
  link_current
  exit 0
fi
mkdir -p "$dir"
(cd "$dir" && npm init -y >/dev/null && npm install --silent "@opencode/cli@$version")
link_current
echo "installed opencode $version at $bin"
