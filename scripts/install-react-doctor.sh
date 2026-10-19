#!/bin/bash
# Idempotent: installs the pinned react-doctor (REACT_DOCTOR_VERSION, server/lib/react-doctor.ts)
# from npm under ~/.local/share/agent-gateway/react-doctor/<version>, where `reactDoctorCommand`
# execs it by absolute path. Never `bunx`: its shared install cache races under concurrent
# reviews (`Failed to link <pkg>: EEXIST`, 73 of 520 runs failed, measured 2026-10-19). The
# lockfile (bun.lock) stays in that directory. Callers treat a failure as non-fatal.
set -euo pipefail
cd "$(dirname "$0")/.."
bun=/opt/homebrew/bin/bun
version="$("$bun" -e 'import { REACT_DOCTOR_VERSION as v } from "./server/lib/react-doctor.ts"; console.log(v)')"
dir="$HOME/.local/share/agent-gateway/react-doctor/$version"
bin="$dir/node_modules/.bin/react-doctor"
installed() { "$bun" -e 'console.log(require(process.argv[1]).version)' "$dir/node_modules/react-doctor/package.json" 2>/dev/null; }
if [ -x "$bin" ] && [ "$(installed)" = "$version" ]; then
  exit 0
fi
mkdir -p "$dir"
[ -f "$dir/package.json" ] || echo '{"name":"agw-react-doctor","private":true}' > "$dir/package.json"
(cd "$dir" && "$bun" add --exact --silent "react-doctor@$version")
[ -x "$bin" ] || { echo "install-react-doctor: $bin missing after install" >&2; exit 1; }
echo "installed react-doctor $version at $bin"
