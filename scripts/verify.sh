#!/usr/bin/env bash
# Probes the live agent-gateway (LaunchAgent, 127.0.0.1:7705). Exit 0 = live and healthy.
# Read-only: two GETs, no side effects. Also fails when the shared OpenCode server (its own
# LaunchAgent) is down or not the pinned build — `.opencodeServer` in the same payload.
set -uo pipefail

base="http://127.0.0.1:7705"
fail=0

body=$(curl -sf --max-time 5 "$base/health") || { echo "verify FAILED: $base/health unreachable"; exit 1; }
if [ "$(jq -r '.ok // false' <<<"$body")" != "true" ]; then
  echo "verify FAILED: $base/health -> $body"
  fail=1
fi

body=$(curl -sf --max-time 5 "$base/api/jobs/health") || { echo "verify FAILED: $base/api/jobs/health unreachable"; exit 1; }
if ! jq -e '.ok == true and (.degradedRoutes | length == 0)' <<<"$body" >/dev/null; then
  echo "verify FAILED: $base/api/jobs/health -> $(jq -c '{ok, degradedRoutes, failedLastHour, lastFailure, warnings}' <<<"$body")"
  fail=1
fi

if ! jq -e '.opencodeServer.ok == true' <<<"$body" >/dev/null; then
  echo "verify FAILED: opencode server not ok -> $(jq -c '.opencodeServer' <<<"$body")"
  fail=1
fi

[ "$fail" -eq 0 ] && echo "verify OK: /health ok, /api/jobs/health ok, no degraded routes, opencode server ok"
exit "$fail"
