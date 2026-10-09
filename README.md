# agent-gateway

Job-queue daemon for agent work on the Mac mini: an always-on HTTP server (`:7705`,
loopback only, LaunchAgent `com.jkrumm.agent-gateway`) that hosts a durable job queue,
plus an MCP stdio server (`server/mcp.ts`) that every Claude Code session spawns to submit
work to it. Tools: `check`, `review`, `dispatch`, `overview`, `narrative`, `otel`,
`read_image`, `read_drawing`, `excalidraw_diagram`, `job_status`/`job_wait`. Each long tool
runs as a background job in a worker session (`claude -p` or OpenCode, per the route's
harness) on the model and backend the routing table assigns it. Mini-only by design — see the dotfiles global CLAUDE.md.

## Install / reload

```bash
make install-agent   # one-time: install + start the LaunchAgent
make reload          # after code changes: self-initiated drain via POST /api/shutdown (≤50 min), restart — falls back to `launchctl kill` if the endpoint doesn't answer
FORCE=1 make reload  # forced abort now, discarding running jobs (read-only ones are re-queued once on boot)
```

`make reload`'s normal drain is long (~50 min) because it's self-initiated — launchd's own
`ExitTimeOut` (60s, its measured hard cap regardless of the plist) never engages on that path.
Only a real signal (reboot, logout, or the fallback above) is bound by that 60s cap. Full story:
`docs/deployment.md` § Two shutdown paths, two windows.

Never start the server by hand (`bun server/index.ts`) — the LaunchAgent owns the port.
The MCP server is registered at user scope by dotfiles' `make setup`
(`claude mcp add --scope user agent-gateway -- bun run ~/SourceRoot/agent-gateway/server/mcp.ts`).
A tool **schema** change needs an MCP reconnect (`/mcp`), not just `make reload`.
A **plist** change (`com.jkrumm.agent-gateway.plist`) needs `make install-agent`
(`launchctl bootstrap`) — `make reload` only signals the already-loaded job definition and
refuses if it detects the tracked plist has drifted from the installed one.

## Endpoints

| Route | Purpose |
|-|-|
| `GET /health` | liveness |
| `GET /api/routing` | effective per-tool model/backend table + applied/refused/implied overrides |
| `POST /api/jobs` · `GET /api/jobs[/:id]` | submit / list / poll jobs |
| `POST /api/jobs/:id/cancel` | cancel one job — `pending` lands `cancelled` immediately, `running` gets a best-effort SIGTERM and lands `cancelled` once the worker exits; 404 unknown id, 409 already terminal |
| `GET /api/jobs/health` | queue health for monitoring (`ok` false on ≥3 failures/h or a >15 min pending job) |
| `GET /api/agents[.txt]` | deterministic agent snapshot (no LLM), incl. `humanQueue` |
| `GET /api/overview[.txt]` | snapshot + the latest `overview` job's recommendations; `.txt` takes `?color=1&cols=N` |
| `GET /api/dispatch-policy` | effective repo allowlist/tier ceilings the `dispatch` job is gated on |
| `GET /api/dispatch-schema` | JSON schema the `dispatch` job's worker output must validate against, per tier |
| `POST /api/shutdown[?force=1]` | self-initiated graceful shutdown — what `make reload` calls instead of signaling the process; responds immediately with `{ running }`, drains asynchronously |

Logs: `~/Library/Logs/agent-gateway.jsonl` (structured, both processes), `agent-gateway.{log,err}` (stdio).

## `.env` keys

| Key | Purpose |
|-|-|
| `PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH` | repo roots `dispatch` may run in (default of `AGENT_GATEWAY_DISPATCH_ROOTS`) |
| `GITHUB_TOKEN` | fallback GitHub credential for `dispatch` artifacts (primary is `secrets-run read op://mini/github/token`) |
| `RESEARCH_GATEWAY_URL`, `RESEARCH_GATEWAY_TOKEN` | lets review angle workers validate external claims |
| `AGENT_GATEWAY_MODEL_<TOOL>`, `AGENT_GATEWAY_BACKEND_<TOOL>` | per-tool routing override (`iu` \| `max`); a gateway id never lands on `max`, and a backend override on `adversary`/`read_image`/`read_drawing` (fixed `iu-openai` transport) is refused |
| `AGENT_GATEWAY_HARNESS_<TOOL>` (`claude` \| `opencode`), `AGENT_GATEWAY_VARIANT_<TOOL>` | per-tool harness/reasoning-effort override — `dispatch`/`dispatch_implement` default to `opencode` over IU's OpenAI route (model: `GET /api/routing`), refused on a fixed-transport tool same as the model/backend overrides |
| `AGENT_GATEWAY_WORKER_FALLBACK=none` | disable both fallback directions |
| `AGENT_GATEWAY_REVIEW_OCR=0` | disable the OpenCodeReview (`ocr` CLI) phase-1 review input |
| `AGENT_GATEWAY_JOB_CONCURRENCY` (3) | running-job cap |
| `AGENT_GATEWAY_AGENT_STALE_HOURS` (24) | agent snapshot stale threshold |
| `AGENT_GATEWAY_KUMA_PUSH_URL` (else `~/.config/uptime-kuma/agent-gateway-push-url`, chmod 600) | full Uptime Kuma push-monitor URL (`https://<kuma-host>/api/push/<token>`); each tick pushes `down` + reason when a route is degraded or the queue unhealthy, else `up`. Unset = no push, one warn, Kuma's missed-heartbeat alert fires |
| `AGENT_GATEWAY_KUMA_PUSH_INTERVAL_MS` (60000) | Kuma heartbeat interval |
| `AGENT_GATEWAY_BREAKER_COOLDOWN_MS` (300000) | how long a tripped `tool@iu/model` circuit breaker sends the first attempt straight to the route's fallback before one probe retries the primary |
| `ARGO_URL` | Argo API base for the overview push (default `https://argo.jkrumm.com/api`) |

The HTTP server gets `.env` from Bun's cwd auto-load; the MCP process reads the same file
through `server/lib/load-env.ts`. Every routing/backend flag is read at module load —
`make reload` applies it.

## Routing

`server/lib/routing.ts` is the single per-tool table. Live: `GET /api/routing`.
Overrides: `AGENT_GATEWAY_MODEL_<TOOL>`/`AGENT_GATEWAY_BACKEND_<TOOL>`. Full rationale:
`brain/wiki/engineering/model-routing.md`.

## Develop

```bash
bun test              # 26 files, no network, no model calls
bun run lint          # oxlint
bun run format:check  # oxfmt
```
