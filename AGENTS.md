# agent-gateway — Agent Instructions

## Architecture

Bun/Elysia backend (no UI), running natively on the host,
loopback-only on `:7705`. Reached via Caddy: `https://agent-gateway.test` locally
— **no tailnet door, deliberately**. `~/.config/caddy-tailnet.ports` carries
an explicit `exclude agent-gateway`: the job API has no auth, so a tailnet twin
would let any tag:mac/phone/tablet node `POST /api/jobs` with `dispatch
implement`. Don't remove that exclusion.

**Renamed 2026-10-09.** CLI `agw`, MCP server and tools `mcp__agent-gateway__*`, env prefix `AGENT_GATEWAY_*`, Caddy door `agent-gateway.test`. The persisted usage-tracker contract followed on 2026-10-13: `agent-gateway-iu` and `agent-gateway-sessions` sinks, `src: "agent-gateway"`, `agent-gateway:<tool>` lanes (stored rows and sink files migrated in place).

Bun loads `.env` automatically from the `agent-gateway/` directory — all env vars
(`PERSONAL_REPOS_PATH`, `WORK_REPOS_PATH`, `GITHUB_TOKEN`, `AGENT_GATEWAY_*`,
`RESEARCH_GATEWAY_*`) live there, listed in `README.md`. That auto-load is
cwd-based, so the **MCP process** (spawned with the calling session's cwd)
imports `server/lib/load-env.ts` first thing in `mcp.ts` to read the same
file — existing environment always wins over the file.

## Validate

`make check` — format (`oxfmt --check`), lint (`oxlint`), typecheck
(`bun run typecheck` = `tsc -p tsconfig.server.json --noEmit --allowImportingTsExtensions`),
`bun test`; non-zero on failure, no side effects. A type error gates a change the same
way lint and tests do.

## Deploy

`make deploy` — ships the checked-out HEAD: `make reload`, then `make verify`
(retried for ~15 s while the boot settles). On a failed verify it rolls back:
only with a clean working tree, `git switch --detach HEAD~1` + `make reload` +
verify, and prints loudly that the checkout is detached (return with `git switch
master`); with a dirty tree it refuses and says how to recover. `FORCE=1` /
`RESTART_MCP=1` pass through to `reload`, whose refusals (running jobs, plist
drift) stay intact — `scripts/deploy.sh`. Those refusals come from
`scripts/reload-preflight.sh` (exit 3, which `make` would collapse to 2, so deploy.sh
runs it directly): a refusal exits 1 with no rollback since the old server was never
touched; any later reload failure rolls back like a failed verify. Detail below.

**A second LaunchAgent, `com.jkrumm.agent-gateway-opencode`**, runs the shared OpenCode v2
server dispatch episodes attach to (§Worker routing). `make deploy` installs it only when it is
not loaded at all, before the reload (a failed install aborts the deploy untouched) — it never
restarts a loaded one, since that kills attached episodes. If the server is still not ok afterwards
(`bun scripts/opencode-server-env.ts --status`) the deploy aborts BEFORE the reload with the fix
commands and no rollback; a post-reload verify that fails ONLY on `opencodeServer` is reported as an
opencode-server problem and does not roll master back. `make install-opencode-agent` (same
bootout/cp/bootstrap shape as `install-agent`, refuses while jobs run, `FORCE=1` skips) applies a
changed `com.jkrumm.agent-gateway-opencode.plist` or wrapper environment;
`make uninstall-opencode-agent` removes it (state kept). Logs
`~/Library/Logs/agent-gateway-opencode.{log,err}`. An opencode upgrade is a deliberate act gated
on `bun scripts/opencode-v2-probe.ts` (`docs/opencode-v2.md`).

**agent-gateway runs exclusively via LaunchAgent. Never start it standalone.**

- `make dev` and `make start` are intentionally broken — they exit with an error.
- Do NOT run `bun run dev`, `bun run start`, `bun server/index.ts`, or anything that starts a server directly.
- Port 7705 is owned by the LaunchAgent. Starting a second process there causes conflicts.

```bash
make reload          # After code changes: self-initiated drain (POST /api/shutdown) + restart. Every OpenCode session under a job is DETACHED at the start of the drain (keeps running on the shared server, re-attached by the next boot), so the drain waits only for jobs it cannot detach — `claude -p` sessions, check steps, single-shot requests (≤50 min — launchd's real signal-and-wait timer never engages on this path). Refuses only while such blockers run (`drainBlockers` in `/api/jobs/health`; OpenCode-only runs never refuse) — WAIT=1 skips that refusal and drains instead: `draining` blocks every new pending → running promotion, so a busy server cannot starve the reload; FORCE=1 aborts the drain at once (force=1 request, or a real SIGINT): claude workers are killed and resumed/requeued on boot, OpenCode sessions are still detached, not discarded; escalating an in-progress drain if one is running. Falls back to `launchctl kill` (short window, capped by launchd's measured 60s ExitTimeOut) if the endpoint doesn't answer. Also refuses on tracked/installed plist drift (file AND launchd's live state) — see docs/deployment.md § Two shutdown paths, two windows
make install-agent   # One-time: install + start LaunchAgent
make uninstall-agent # Remove LaunchAgent

tail -f ~/Library/Logs/agent-gateway.log   # stdout
tail -f ~/Library/Logs/agent-gateway.err   # stderr
```

The LaunchAgent starts automatically on login and restarts on crash.

**Logs live in `~/Library/Logs`, never `/tmp`** — a KeepAlive agent opens its
stdio once at spawn, and macOS's periodic cleanup sweeps untouched `/tmp`
files after 3+ days, leaving the process writing into an unlinked inode
(agent-gateway lost a post-mortem to exactly this once). The paths live in
`com.jkrumm.agent-gateway.plist`; `make install-agent` copies that file
verbatim over the live one, so change the tracked file, never the live one.

**The label is `com.jkrumm.agent-gateway` and the program is a wrapper
script (`scripts/agent-gateway-start.sh`), not `bun` directly — both are macOS
Background Task Management workarounds, not style.** Reverting either brings
back "agent-gateway doesn't come up after a power cut" (measured across three
reboots 2026-08-06). Verify after any plist change:

```bash
log show --last 2m --info | grep -A3 agent-gateway.plist | grep effectiveItemDisposition
# want: result=[enabled, allowed, ...]
```

Full forensic story (why BTM denies this specific label/executable):
`docs/deployment.md`.

## Verify & Monitor

- `make verify` — `scripts/verify.sh`: `GET /health` → `ok`, `GET /api/jobs/health`
  → `ok == true` and `degradedRoutes` empty, and `.opencodeServer.ok == true` (the shared
  OpenCode server is up and the pinned build; the object is printed on failure).
  Exit 0 = live and healthy.
- Health URL: `http://127.0.0.1:7705/health` (queue health:
  `http://127.0.0.1:7705/api/jobs/health`; loopback only, no tailnet door).
- Kuma monitor: none for agent-gateway itself — the mini heartbeat (dotfiles
  devhost-health) reads `/api/jobs/health`.
- OTel `service.name`: none — agent-gateway emits no OTel; structured logs are NDJSON
  in `~/Library/Logs/agent-gateway.jsonl` (`.claude/rules/logs.md`, `docs/logging.md`).
- `make logs` — last 100 lines of `agent-gateway.err` and `agent-gateway.log`, last 50 of
  `agent-gateway.jsonl`, then exits.

## Gotchas

- **Never start the server standalone** — LaunchAgent only; `make dev`/`make start`
  are broken on purpose (§Deploy).
- **MCP schema changes need a client reconnect** — `make reload` does not restart the
  MCP process; Zod strips the unknown field until `/mcp` reconnects
  (§MCP Server).
- **`tsc` runs on `tsconfig.server.json`, not the root config** — `tsconfig.json` has
  `files: []`; `bun run typecheck` (part of `make check`) names the project (§Validate).
- **Logs live in `~/Library/Logs`, never `/tmp`** (§Deploy).
- **No tailnet door, deliberately** — the job API has no auth; keep the
  `exclude agent-gateway` in `~/.config/caddy-tailnet.ports` (§Architecture).
- **Label `com.jkrumm.agent-gateway` + the `scripts/agent-gateway-start.sh` wrapper are
  macOS BTM workarounds** — don't "simplify" them (§Deploy).
- **Edit the tracked plist, never the live one** — `make install-agent` overwrites it.

## MCP Server

agent-gateway exposes workflow tools (`check`, `review`, `dispatch`, `update_pr`, `decide`, `overview`,
`narrative`, `triage`, `otel`, `prose`) plus the synchronous multimodal tools (`read_image`,
`read_drawing`, `excalidraw_diagram`) plus the job-polling tools
(`job_status`, `job_wait`, `job_steer`, `job_cancel`) as an MCP server — a **separate process** from the
LaunchAgent, spawned on-demand by Claude Code via stdio transport.
`GET /api/agents` (below) is HTTP-only, deliberately outside this MCP
surface — see `### agents, overview, narrative`. `otel` alone runs inline via
`runSession`, never as a job — no `jobId`, no `job_wait` — by decision:
`brain/wiki/engineering/model-routing.md`.

Entry point: `server/mcp.ts`. Thin MCP tool wrappers live in
`server/mcp/tools/`; the actual execution logic + schemas live in
`server/jobs/handlers/`; skill prompts in `server/skills/`.

**Deploying schema changes:** `make reload` only restarts the launchd HTTP
server (job execution + skill-prompt reads, which load from disk per-run). It
does NOT restart the MCP process — that's owned by the calling Claude Code
session. So an edited tool **input/output schema** (e.g. a new
`commands`/`validateCmd` field) is not visible to a connected client until
its MCP reconnects; until then the SDK's Zod validation silently **strips**
the unknown field before it reaches the handler. After changing a tool
schema, reconnect `/mcp` (or restart the session) — not just `make reload`.
Skill-prompt and handler-logic edits need only `make reload`.

### CLI — the same jobs, without an MCP client

`bin/agw.ts` (`make install-cli` → `~/.local/bin/agw`) is a plain
HTTP client of the routes below — **no MCP layer**, so OpenCode, Codex, a
shell, a Makefile or cron can drive the same work Claude Code drives through
MCP:

```bash
agw dispatch --repo warden --tier implement --workspace in-place 'the brief'
agw check --repo agent-gateway          # submit + wait, progress on stderr
agw review --pr 42 --json          # stdout carries ONLY the result JSON
agw prose draft.md --medium vault --out draft.md   # text on stdout/--out, summary + notes on stderr
agw jobs --running · status|wait|cancel <jobId> · steer <jobId> <text> · routing · policy · health
```

`--no-wait` prints the jobId and exits; `--json` makes stdout machine-readable
(progress stays on stderr); `--timeout` is opt-in, the default wait has no
ceiling (`.claude/rules/agent-limits.md`). Exit codes: **0** done · **1**
failed/interrupted/cancelled · **2** usage error or `dispatch refused: …` ·
**3** server unreachable. Same policy, same queue, same concurrency cap as the
MCP door — the CLI adds no capability, only reach.

`agw prose [<file>|-] [--medium <m>] [--language en|de] [--register <r>] [--brief <text>] [--context <file>] [--no-verdict-first] [--out <file>] [--json]`
submits a `prose` job (flags map 1:1 onto `PROSE_INPUT`; `--context` reads a file; `--medium` defaults to
`docs` because the schema requires one), waits with no ceiling, and writes the resulting text (the rewrite,
or the original when the keep gate declined) to stdout or `--out`. stderr gets one summary line (kept, reason,
language, format, cost, duration) plus the reviewer notes; `--json` prints the full result instead of the text.
Exit 0 whenever the job finished, even if it kept the original.

### Async job model (durable, off the MCP transport)

The long tools (`check`/`review`/`dispatch`/`overview`/`narrative`/`triage`/`decide`/`prose`) do
**not** block the MCP call. A 13-minute worker run held open as a single MCP
request destabilizes the stdio transport (and the SDK's 60s client timeout).
Instead:

1. The MCP tool **submits a job** to the always-on HTTP server
   (`POST /api/jobs`) and returns `{ jobId, status }` immediately. (Submit still runs the
   synchronous refusals; a `dispatch` with `branch` adds one `git ls-remote` against origin,
   capped at 5 s, under the MCP client's 10 s submit abort.)
2. The HTTP server (LaunchAgent, durable) runs the job in the background and
   persists state to **bun:sqlite** (`~/.local/share/agent-gateway/jobs.db`), not
   `/tmp` for the same sweep reason as the logs (`server/jobs/store.ts`). The
   server binds **`127.0.0.1:7705` only** — every consumer (herdr pane,
   Hermes, the MCP child, `fetch_usage.py`, devhost-health) is local and the
   API carries no auth of its own.
3. The caller polls **`job_wait({ jobId })`** — a long-poll (~50s,
   heartbeated) that returns the result the moment the job finishes, or
   `stillRunning: true` to call again. `job_status` is a one-shot peek.
   An explicit `maxWaitMs` may go up to **29 min**, turning a `review`'s ~9
   round trips into one — but only because this server's `~/.claude.json`
   entry carries a matching `timeout` (1800000). **The two are one setting in
   two files**: without the client half, a long wait is aborted at 60s as a
   hard error, where the 50s default would have returned a clean
   `stillRunning`. Leave the default alone; raise it per call.

While a job runs, `job_status`/`job_wait` also expose live worker progress
derived from the worker's stream-json output: `turns`, `lastAction` (e.g.
`"Edit store.ts"`), and **`idleMs`** — ms since the last worker event. A
_large and still-growing_ `idleMs` means the session may be stuck — peek at
`git status` rather than waiting indefinitely.

Why the HTTP server hosts jobs (not the MCP process): the MCP process dies on
`/mcp` disconnect, but the HTTP server is launchd-managed. Jobs survive MCP
reconnects; disk persistence survives an HTTP restart: on boot `recover()`
re-queues an interrupted `check`/`overview`/`narrative`/`review`/`triage`/`decide`/`prose` **once**
(all read-only; `prose` is not cost-idempotent — a crash after the writer's billed reply re-bills both calls) and marks everything else `interrupted`
(`dispatch` is never auto re-run — an `implement` episode may already have
pushed). A job whose OpenCode session(s) a drain **detached** is not a crash and is
requeued whatever its attempts say — see _Durable and steerable OpenCode
episodes_ below. `make reload` refuses while jobs it cannot detach are running
(`reloadRefusals`: `claude -p` sessions, check steps — OpenCode-only runs never
refuse; the drain also waits for short single-shot jobs, which are not a reason to refuse) unless `FORCE=1` (which asks for the same forced abort as always — never
SIGKILL, which isn't catchable and would skip `terminateActiveSessions()`
entirely, orphaning `claude -p` workers that keep writing/committing after the
reload believed it had stopped them). Otherwise `make reload` now asks the server to shut itself
down (`POST /api/shutdown`, `server/routes/shutdown.ts`) instead of signaling
it: launchd's `ExitTimeOut` only engages when launchd itself sends the signal
and waits, so a self-initiated exit never starts that clock and can drain for
up to `HTTP_DRAIN_GRACE_MS` (~50 min, sized to the dominant single-attempt
worst case, not the full double-timeout-fallback chain). A real SIGTERM/SIGINT
(reboot, logout, launchd itself, or `reload`'s own fallback when the HTTP
endpoint doesn't answer) instead gets `SIGNAL_DRAIN_GRACE_MS` (45s) — launchd's
`ExitTimeOut` is hard-capped at 60s on this host regardless of what the plist
says (measured 2026-09-08), so that path has to stay short. Full story of both
windows: `docs/deployment.md` § Two shutdown paths, two windows. A forced
abort (`force=1`/SIGINT) arriving mid-drain escalates it to an immediate
abort rather than being dropped. A job whose worker is one the drain
actually terminated is left `running` for the next boot's ordinary
crash-recovery, not written `failed` — an unrelated failure that merely
lands in the same drain window still is. `make reload` also refuses
outright if the tracked plist has drifted from the one launchd has loaded —
checked both as a file compare and against launchd's own live
`exit timeout` — `launchctl kill` never re-reads a changed plist, only
`launchctl bootstrap` (`make install-agent`, which boots the current label
out first so that bootstrap reliably takes, waits for the old PID to
actually exit before copying the plist and bootstrapping, and now fails
loudly — rather than reporting success unconditionally — if the new
instance never comes up on `:7705`) does. A **concurrency
cap per admission lane** (`laneOf(tool)` in `server/jobs/store.ts`) queues excess submissions as
`pending` so parallel agents can't trip the IU unified endpoint's rate
limits. The **session lane** (every tool but the two below; `AGENT_GATEWAY_JOB_CONCURRENCY`,
default 3) is the original cap. The **single-shot lane** (`triage`, `decide` — one tool-less IU
request each, no worker session; `AGENT_GATEWAY_SINGLE_SHOT_CONCURRENCY`, default 6) does NOT
count against the session cap, so a warden shadow `decide` never waits behind a 10-minute
`review`. `promote()` walks pending rows oldest first and admits a row when ITS lane has room (FIFO
per lane; a full lane never blocks the other). `review_router` is not a job, it runs inside the
`review` job. While draining, the queue backs up too, which `GET
/api/jobs/health`'s `draining: true` flag distinguishes from a wedged queue.

**Durable and steerable OpenCode episodes (Waves 4 and 9, `docs/opencode-v2.md`).** Every OpenCode
session a caller can hand back (it runs under a job AND passes `reattachKey` or `onSessionId` —
`canDetachSession`) is detached by a drain — not interrupted — and re-attached by the next boot;
`claude -p` sessions, and OpenCode sessions nothing can re-attach (a repo check run for dispatch or
`update_pr`, excalidraw), still drain or requeue. The drain does it at its **start**
(`createShutdownController` → `detachSessions` → `detachRemoteSessions()`, session-runner.ts): the
session keeps running on the shared server, `SessionDetachedError` unwinds its handler, and the jobs
are marked durably (`jobs.detached_at`, `markJobsDetached`) before the process can exit. The drain
then waits only for **`drainBlockers`** (`QueueStats`/`/api/jobs/health`): running jobs whose live work
is NOT purely detachable OpenCode sessions (a `claude -p` session — also one running NEXT TO a
detached OpenCode one in the same job —, a check step, a non-detachable session, a single-shot request,
a job between phases) — a drain with only detachable sessions in flight is over at once, and a
detachable session that would start mid-drain detaches before it creates anything (re-checked right
before `createSession`). Re-attach is by state, the same
logic everywhere (`runOpencodeAttempt`): live → wait only, finished while down → read the result,
cut off → `prompt {resume:true}`, never prompted → a first prompt. How a job hands its session back
differs: **dispatch** persists the session id on the job row (`onSessionId` → `session_id`, the
worktree's `worktree_meta`); **every other tool** passes `SessionOptions.reattachKey` and the runner
records the session it creates in the **session ledger** (`job_sessions(job_id, key, session_id,
settled)`, key = `reattachKey` exactly — the persisted ROW decides, no counter: a failed attempt
drops its row, so at most one survives per key and it is the session to continue; a repeat call in the
same process is a handler-level retry and starts fresh) — review: `angle:<name>` per angle and
`synthesis`, check/overview one key each; a
`ref`-mode review also keeps its throwaway worktree on detach (`worktree_meta`, protected from the
boot sweep) and the re-run reopens it. A detached `review` aborts at once (the detach is not an angle
failure, does not consume `ANGLE_MAX_ATTEMPTS`) and is requeued by `recover()`; its OCR run, claude
sibling sessions, adversary and synthesis simply run again, while angles with a ledger row re-attach
(finished → result read from the messages, still running → waited). A detached session writes no usage
row; a `settled` ledger row (usage already attributed) re-attaches without writing a second one.
**Requeue accounting:** a row with `detached_at` is requeued by `recover()` regardless of `attempts`,
for `dispatch` and the `REQUEUE_ON_RECOVER` tools (`resumesAfterDetach`), and gives the attempt back
(`attempts - 1`, logged `attemptRefunded`, so a later genuine crash still gets its requeue-once); a
row without it — or of any other tool — keeps today's rules. **In-place dispatch** is detached and resumed
too: its metadata marker persists the pre-episode snapshot (`{ path, workspace: "in-place", snapshot }`,
dispatch-git.ts `InPlaceSnapshot`), so the re-attached run reports `applied_in_place` against the
SAME baseline; with no marker (a crash) or no persisted snapshot (an older row) it is still
`interrupted`, its edits left uncommitted. The snapshot's stash commit is a dangling object — safe
across a reload, not across `git gc` weeks later. Pending-time accounting: `recover()` sets
`requeued_at` and `jobHealth` ages `oldestPendingAgeMs` from there (not from submission), so a
requeued job never trips the 15-min rule; `job.requeue` logs `detached`/`detachedForMs`, `job.recover`
logs `detachedResumed`, `job.start` logs `pendingMs`. A detached session whose job is NOT resumed
(recover → `interrupted`/`cancelled`) is interrupted on boot. Cancel still interrupts.
**`POST /api/jobs/:id/steer {text}`** (MCP `job_steer`, CLI `agw steer`)
injects `delivery: steer` text into a RUNNING dispatch's session (409 when nothing is live; logged
`job.steer`). A new MCP tool needs a `/mcp` reconnect before a connected client sees it.

**`POST /api/jobs/:id/cancel`** (MCP: `job_cancel`, CLI: `agw cancel`) cancels one job — `pending` lands `cancelled`
immediately, `running` gets a best-effort SIGTERM (`terminateSessionsForJob`)
and lands `cancelled` once the worker exits, never `failed` and never counted
in `failedLastHour`; an already-terminal job answers 409, which `job_cancel` returns as `outcome: already_terminal`, not an error. The
`cancelled` value is a widened enum on `job_status`/`job_wait`'s output schema
too, so per the MCP-schema-change rule above, an already-connected client needs
an `/mcp` reconnect (or session restart) before it can poll a cancelled job
without its Zod validation silently stripping the field.
A `prose` cancel lands after the in-flight writer call returns, as `cancelled`: `isCancelled` is checked between stages and after the writer, and no `AbortSignal` is threaded into the model call. A running prose job is a drain blocker, so `make reload` refuses while one runs.

**Alerting (Wave 4).** `server/lib/health.ts` `computeHealth()` is the payload behind
`/api/jobs/health` plus `pageable`/`pageReason` (`!ok` or any `degradedRoutes`) and
`openBreakers`. `server/lib/kuma-push.ts` pushes it to an Uptime Kuma push monitor every
`AGENT_GATEWAY_KUMA_PUSH_INTERVAL_MS` (60 s): `down` + reason when pageable, else `up`. Push URL:
`AGENT_GATEWAY_KUMA_PUSH_URL` or the chmod-600 file `~/.config/uptime-kuma/agent-gateway-push-url`;
unresolved URL = warn once and no push, so Kuma's missed-heartbeat alert fires. A drain keeps
pushing `up`; the timer stops only on process exit.

**Circuit breaker.** `tool@iu/model` opens after `ROUTE_STREAK_LIMIT` consecutive transport-class
failures (429/5xx/connection; not 4xx, not stalls) for `AGENT_GATEWAY_BREAKER_COOLDOWN_MS` (5 min).
While open, a route that declares a fallback goes straight to it (`reason: breaker-open`, counted
in `backendFallbacks`); after the cooldown one probe tries the primary. No fallback or
`AGENT_GATEWAY_WORKER_FALLBACK=none` = never short-circuits. It reacts to observed failures — not
the removed proactive quota pre-check.

**Retention.** Full `jobs` rows are pruned at 24 h / 200 rows; a slim `job_stats` table (no params,
no result; tool, status, timings, attempts, backend, model, 300-char error head, repo) is written
at every terminal transition and kept 90 days. `jobStatsSummary(days)` in `server/jobs/store.ts`
aggregates it.

**MCP Tasks extension** (`io.modelcontextprotocol/tasks`, SEP-2663, Final; verified 2026-10-09).
TypeScript SDK 1.x does not implement it (v1 tops out at spec 2025-11-25, only the legacy
`.experimental.tasks` API), so this server stays on stdio + SDK 1.x. When an SDK ships it:
`jobId` ≙ `taskId`, `job_wait` ≙ `tasks/get` polling (no `tasks/result` exists in the extension),
`job_cancel` ≙ `tasks/cancel`; status map pending/running → `working`, done → `completed`,
failed/interrupted → `failed`, cancelled → `cancelled`.

Job lifecycle events log to `~/Library/Logs/agent-gateway.jsonl` (`job.create` /
`job.start` / `job.done` / `job.fail` / `job.cancelled` / `job.recover` /
`job.requeue` / `job.shutdown_abandoned` / `job.shutdown_detached` / `job.lease_unavailable`). Inspect the queue:
`curl -s localhost:7705/api/jobs | jq`.
**`GET /api/jobs/health`** → `{ ok, running, pending, max, singleShot: { running, pending, max,
oldestPendingAgeMs }, drainBlockers, failedLastHour,
interruptedLastHour, oldestPendingAgeMs, leaseQueued, lastFailure, draining, sinceBootMs,
recoveredFromDrain }` (`running`/`pending`/`max`/`oldestPendingAgeMs` are the session lane;
`drainBlockers` is what the drain waits for (single-shot jobs included) and `reloadRefusals` the
session-lane subset `make reload` refuses on — the preflight reads only it;
`oldestPendingAgeMs` runs from the last requeue, `jobs.requeued_at`, not the submission;
`singleShot` is the `triage`/`decide` lane with its own oldest-waiting age;
`leaseQueued` counts pending rows waiting behind a per-repo implement
lease; they are excluded from `oldestPendingAgeMs`), `ok: false` when ≥3 jobs failed in the last hour, or
the oldest pending job in EITHER lane has waited >15 min **and neither grace applies**: a
drain intentionally stalls promotion, so queue backup alone never trips it
while one is in flight (`draining: true`); the same backlog also gets a
`BOOT_HEALTH_GRACE_MS` (5 min) pass right after a restart, but **only** when
`recoveredFromDrain` is true — i.e. the previous process ran its shutdown
path to the **end** (a persisted marker written by `markDrainCompleted()` when
the drain finishes, read and cleared once on the next boot), not merely
`sinceBootMs` being small. Written at the drain's _start_ it would also survive
a mid-drain SIGKILL and hand the grace to the very crash loop it exposes. A
raw crash never sets that marker, so a
crash-looping process gets no grace — the backlog stays visible on every
restart instead of permanently hiding behind "just booted." dotfiles'
devhost-health reads it. A failed worker's stderr is logged at
**warn** (`session.stderr`) so a post-mortem exists.

### agents, overview, narrative — one snapshot, one triage pass, one vault writer

`GET /api/agents[.txt]` (`server/lib/agents.ts`) is a **deterministic,
read-only, no-LLM** snapshot of every Claude Code agent on this Mac mini,
grouped by project, merged across `herdr agent list`, `claude agents --json`
and the dispatch job store by sessionId — the single producer behind an
agent overview rendered by Hermes, an Argo dashboard, a brain page and a
herdr pane. `?color=1`/`?ansi=1` and `?cols=N` (40–200, default 110) support
the herdr phone-width pane. `humanQueue` (top-level) surfaces pending
`ask-human.sh` requests, never fed into the LLM prompt. `state` (`needs_you >
working > stale > idle > done > unknown`, `AGENT_GATEWAY_AGENT_STALE_HOURS`
default 24) is the only field consumers should branch on. Full merge/tail-read
mechanics: `docs/agent-overview-internals.md`.

The `overview` job enriches that snapshot with **one LLM recommendation per
agent** (`answer`/`continue`/`ship`/`review`/`merge`/`close`/`stale`/`watch`,
each with `standing`/`blocker`/`confidence`) — one batched, prompt-only call
(`readOnly: true` + `toolless: true`, no repo tools — the `agw-toolless` OpenCode profile),
model/backend from `routeFor("overview")` (Haiku 5.5 EU on OpenCode, Sonnet on Max as the reverse
lane — see `GET /api/routing`). `GET /api/overview[.txt]` never runs the
LLM inline — it merges the latest **completed** job result onto a fresh
snapshot, and marks a recommendation `recommendationStale: true` if the agent
has been active since. Full reconciliation/fencing detail:
`docs/agent-overview-internals.md`.

**Multi-account quota.** Two Claude Max accounts (`iu`, `me`) run on the mini; the quota cache is
owned by the dotfiles CLI `claude-account` and read via `claude-account usage --json`
(`server/lib/claude-usage.ts`: 5 s timeout, 15 s memo, env scrubbed of credentials, null on
failure). `GET /api/usage` → `{ok, data, accounts}`: `accounts` is keyed by id with
`five_hour_pct, seven_day_pct, five_hour_resets_at, seven_day_resets_at` (epoch s),
`five_hour_mins_left, auth_ok, exhausted_until, enabled, plan, updated_at` (epoch ms), `source`; a
POST newer than the CLI sample overrides per window. `POST /api/usage` takes an optional `account`
(`/^[a-z][a-z0-9-]{0,15}$/`, default `iu`); `data` stays the last `iu` POST (back-compat).
`/api/overview` adds `quota: {accounts, picks}` and per-agent `account`; `picks` is the 6 routing
lanes' `claude-account pick --lane <lane> --dry --why` answer (`{picked, reason, stale}`), same
15 s memo/SWR window as `accounts`, `{}` when the CLI is down. `/api/overview.txt` gets a quota
header line per enabled account and an account column. See `docs/agent-overview-internals.md`
§ Quota header and account column.

The `narrative` job writes/revises one project's Obsidian vault page from
git log + session transcripts + `voice.md` — business terms, never a
changelog; `changed: false` with no page is a correct default answer, not a
failure. Model/backend from `routeFor("narrative")` (Haiku 5.5 EU on OpenCode,
tool-less, Sonnet on Max as the reverse lane — measured equal to the Sonnet seat in
Wave 10, `docs/routing-and-quota.md`). Caps
enforced in code (`clampSections`), never trusted from the model. After rendering, the page body
is polished in-process by `runProsePipeline` (medium `vault`, language auto; `polishPage`): the YAML
frontmatter is stripped before and reattached verbatim after, and a prose throw, an unusable setup (no
voice file) or a declined rewrite returns the unpolished page — prose never fails a narrative job (only a
cancel propagates). Polish is on by default and adds one reviewer + one writer call (~$0.05, 20-90 s)
to every run; `polish: false` opts out. It runs with `verdictFirst: false` and a brief that lists the
page's headings, and a rewrite whose heading lines differ from the original's is declined. The result's
`prose` carries `{status: polished|declined|errored, kept, keptReason?, costUsd}` (`sections` stays the
worker's unpolished data). `narrative` is in `REQUEUE_ON_RECOVER`, so a crash after the writer call
re-bills the polish on recovery (accepted). Full input/output contract and gathering rules:
`docs/agent-overview-internals.md`.

### prose — human-facing text, improved in a fixed pipeline

The `prose` job (`server/jobs/handlers/prose.ts`, MCP `prose`) turns a draft (article section,
vault page, landing or UI copy, docs, briefing) into clearer prose: LINT (`server/lib/prose-lint.ts`,
pure code) → REVIEW (`prose_review`, a different lab, notes and scores only) → REWRITE (`prose_write`,
the voice guide plus the review) → RE-LINT. The voice guide is read by `server/lib/voice.ts` from
`AGENT_GATEWAY_VOICE_PATH` (default `~/SourceRoot/brain/voice.md`, capped at `VOICE_MAX_BYTES` = 16 KB with a
warn when exceeded), shared with `narrative`; a missing file fails a prose job, while narrative runs without it.
The rewrite is kept only if it stays in the draft's format (`html` when the prose has block-level tags, else `markdown`; an html rewrite may carry no markdown `> [visual:` line, table or heading), carries over every fenced code block (exact text), URL (html `href`/`src` values included) and Obsidian wikilink target (`[[t]]`, `[[t|alias]]`, `![[embed]]`; compared as a multiset by target, the alias may change) of the original, adds none, AND no
lint rule has more findings than in the original; otherwise the original comes back with `kept: "original"` and
`keptReason`. The job runs on the **session lane** (up to three long calls on up to 60k chars would hold a
single-shot slot and block the drain) and checks `isCancelled` between review and write and between writer retries. The writer is one anthropic-wire
Messages call (`anthropicComplete`, single-shot.ts: 32000 max tokens, adaptive thinking at high effort; empty
text on `max_tokens` is `starved`, text cut off by it is `truncated`; both are content failures that keep the
original with the billed usage carried and a warn `prose.writer_content_failed`, while transport errors
fail the job, and a hang-guard timeout is never retried). The
findings, reviewer notes and `brief` ride in the user turn inside nonce-fenced data blocks with the draft
(`fencePreamble` before, `endOfData` after, so attacker text is never the last thing read), never in the system prompt. The writer (anthropic wire) and reviewer (chat wire) must be different labs and
the pair is refused at submit (`proseSubmitRefusal`, models from `resolveProseModels`; a non-string `model`/`reviewModel` too).
The Opus ids are `singleShotOnly` in the registry: refused on every route but `prose_write` and on every
other tool's per-job `model`; `AGENT_GATEWAY_MODEL_PROSE_WRITE` must name an anthropic-wire id (refused at startup otherwise). `verdictFirst: false` (an author who builds criteria → candidates → verdict) keeps the section order and drops the `verdict_first` score (stripped in code); the writer's hard rule is to add no recommendation, claim or fact the source lacks (the reviewer flags it as an `invented_content` note); `context` (≤8000 chars, the surrounding outline) rides in its own nonce-fenced read-only block to both calls. The output carries `format`, `mediumNote` (the `MEDIUM_NOTE` table, also printed in the writer's system prompt) and a flat `usage` total plus `usageByCall: {writer, reviewer}`, each with `costUsd` = the gateway's own figure, else `usageCostUsd` (models.ts: registry rates, cache reads at `rate.cacheRead` or 0.1x `in`). English lexicon
rules never run on German text; a draft whose language cannot be told runs the language-agnostic rules only.

Higher-order tools reuse capabilities at the **code level, not via MCP
recursion**: `review` angle workers can validate external library/API claims
against the standalone **research-gateway** (a bounded bearer-auth `curl`,
gated on `RESEARCH_GATEWAY_URL`/`RESEARCH_GATEWAY_TOKEN`) and self-validate
(`check` capability) — no nested jobs, no semaphore deadlock.

### Worker routing — `server/lib/routing.ts` is the only place a model or backend is decided

Every worker session (`runSession`) and the adversary text call take
`{ model, backend, fallback, thinkingTokens }` from one per-tool table;
nothing else hardcodes an id. Handlers pass `route: routeFor("<tool>")`, the
MCP tool descriptions print the same route under `MODEL:`, and **`GET
/api/routing`** shows the effective table plus every applied or refused
override.

Per-angle review routes `review_angle_{senior_dev,typescript,frontend,qa}`:
`senior-dev`, `typescript`, `qa` and `frontend` default to the OpenCode route (Haiku 5.5 since the
Wave-5 bench, previously the Wave-4 flash A/B; `frontend` joined them in Wave 11 on a real-findings
A/B), and every angle without its own key keeps the `review` route. Override via
`AGENT_GATEWAY_MODEL_`/`AGENT_GATEWAY_HARNESS_`/`AGENT_GATEWAY_VARIANT_REVIEW_ANGLE_<NAME>` (an
opencode angle needs both the MODEL and HARNESS overrides; pinning one back to
`review` needs the model override plus `AGENT_GATEWAY_BACKEND_=max`) — see
`docs/routing-and-quota.md` §Review-angle A/B (Wave 4).

`dispatch_implement` and its attempt-3+ escalation `dispatch_implement_escalation` run on Max only
(Sonnet over `claude -p`, `fallback: null`; owner rule 2026-10-24: no code written on IU tokens) —
an override or per-job `model` that would move them onto IU or a non-Claude model is refused;
editorial and investigate stay on IU.

Live table: **`GET /api/routing`**. Overrides: `AGENT_GATEWAY_MODEL_<TOOL>=<id>`,
`AGENT_GATEWAY_BACKEND_<TOOL>=iu|max`, `AGENT_GATEWAY_THINKING_TOKENS_<TOOL>=<n>` (read
once at module load → `make reload`). Full rationale — the tiers, the
reactive fallback, why the proactive quota-ceiling pre-check was removed
2026-09-08 and must not return: `brain/wiki/engineering/model-routing.md`.

**`thinkingTokens` governs a gateway model's reasoning budget on the IU leg**
— `--effort`, `reasoning_effort` and `thinking:{type:disabled}` are all
ignored by the Requesty hop, so `MAX_THINKING_TOKENS` (mapped by the CLI onto
Anthropic's `thinking.budget_tokens`) is the only control that reaches
the gateway models there. Unset means the model's own `max`
default, its worst setting. The retired
`claude -p` AGENT/CLASSIFY tiers ran at 2048 / 8192 (`triage` and review's router are single-shot,
no budget — below); every OpenCode route (check, overview, narrative, excalidraw, dispatch,
dispatch_editorial) controls depth with `variant` instead, and Haiku 5.5 has none —
`server/lib/routing.ts`'s dated comments carry the ccbench/POC evidence.
No route runs on GLM (retired 2026-09-23). `session-runner.ts`'s `buildWorkerEnv` exports `MAX_THINKING_TOKENS`
only for non-Claude models — a Claude route's `thinkingTokens` (currently none
set) would be a no-op there anyway, since thinking on Claude is controlled a
different way. JUDGE (`otel`) carries no `thinkingTokens` — it stays on Claude, as do the two Max-only implement routes.

**Implement can now fail on a quota wall.** With no IU fallback, a `dispatch_implement` episode whose
Max accounts are all walled fails closed (`Claude AI usage limit reached … no iu fallback`) instead
of spilling to IU; callers retry later. The escalation seat is the same config as implement.

**`dispatch`/`dispatch_editorial` run on a second harness, OpenCode, not
`claude -p`** (2026-09-24, `harness: "opencode"` on `ToolRoute` — AGENT_OC; `dispatch_implement`
left it 2026-10-24 for Max-only `claude -p` — every other tool stays `"claude"`). An OpenCode session talks
to Haiku 5.5 EU over the IU native Anthropic route through the `iu-anthropic` provider
(2026-10-14, `docs/routing-and-quota.md` § Wave 5; before that `deepseek-v4.1-flash` over the
OpenAI-compatible `iu-chat` route, which stays the SINGLE_SHOT and OCR model). Measured against the previous
implement model on
`claude -p` (three re-run implement briefs): ~40x cheaper, ~2-4x faster, a
blind diff review preferred it on 2 of 3, lost the third on inverted
volume-floor logic in a HyperDX config — not a clean sweep, and 95-98% cache
hit vs the previous model's 8%. `variant` (opencode's reasoning-effort knob, folded into
the model ref as `provider/model#variant` in 2.x) is carried only by the routes whose model exposes
one (no default route carries one now — Haiku 5.5 has none); opencode's
model/harness combination is validated against the model registry
(`server/lib/models.ts` — id, wire, harnesses, limits, rates, `verified`; also
served as `models` by `GET /api/routing`) AFTER every override
(`buildRoutingTable`'s cross-field pass, routing.ts): an unregistered or
unverified id is refused, an id that lists `claude` but not the route's harness (every Claude id except Haiku 5.5 EU, which also lists `opencode`) normalizes
harness back to `claude`, and an opencode-only id (the OpenAI-route models) with harness `claude` is refused rather than applied. The opencode config
carries three providers generated from the registry: `iu-chat`
(`@ai-sdk/openai-compatible`) and `iu-responses` (`@ai-sdk/openai`, GPT ids
only) over the IU OpenAI base, and `iu-anthropic` (`@ai-sdk/anthropic`, Haiku 5.5 EU) over the
native Anthropic base `IU_ANTHROPIC_BASE` — the one v2-shaped `providers` entry, because only
that form carries `compatibility.supportsThinkingBlockBinding: false` (§ Wave 5 in
`docs/routing-and-quota.md`).
Overrides: `AGENT_GATEWAY_HARNESS_<TOOL>=claude|opencode`, `AGENT_GATEWAY_VARIANT_<TOOL>=<v>`
(a bare `AGENT_GATEWAY_HARNESS_DISPATCH=claude` is accepted since Haiku 5.5 EU lists the
`claude` harness, but that path ran 4x slower in the Wave-5 `check` bench — prefer a Sonnet
`AGENT_GATEWAY_MODEL_DISPATCH` override with it; an opencode-only model such as `DeepSeek-V4-Pro`
is still refused). A fallback
attempt (the `iu`→`max` reverse lane) always runs `claude -p` regardless of
the primary's harness — Max only ever serves a Claude id. Implementation:
`server/mcp/opencode-runner.ts` (the drive loop + message summarizer) over `server/mcp/opencode-client.ts`
(the typed HTTP port), invoked from
`session-runner.ts`'s `runSessionAttempt` via `resolveHarness()`.

**One shared server, driven over HTTP (Waves 2–3, 2026-10-14; `docs/opencode-v2.md`).** An episode
is a SESSION on ONE long-lived `opencode serve` under its own LaunchAgent
(`com.jkrumm.agent-gateway-opencode`, port `AGENT_GATEWAY_OPENCODE_PORT`, state in
`~/.local/share/agent-gateway/opencode/`, HTTP Basic password in its `0600` `password` file).
There is no `opencode run` child process and no CLI fallback path: `runOpencodeAttempt` drives
`POST /api/session` → `PUT …/environment` → `POST …/prompt` → `POST /api/experimental/session/{id}/wait`
→ `GET …/message` through the `OpencodeClient` port (`server/mcp/opencode-client.ts`, a thin
zod-typed `fetch` adapter; tests inject an in-memory fake of the same interface).
`server/mcp/opencode-server.ts` owns the server itself: the pinned version
(`OPENCODE_PINNED_VERSION`), the generated config, the permission rule arrays,
`getOpencodeServerStatus()`, `interruptOpencodeSession`. What a session sets (measured on 2.0.25, re-probed green on 2.0.29):
(1) **permissions live in three v2 agents** in the server config (`OPENCODE_CONFIG_CONTENT`, set on
the server process — it overrides a repo-local `opencode.json`; never the `OPENCODE_CONFIG` file
path, which a repo file overrides), selected with `agent` on session create: ordered
`{action,resource,effect}` rules, LAST match wins, only `allow`/`deny` (an unmatched action
defaults to `ask`, which blocks an unattended session forever — `agw-readonly` opens with a
catch-all deny, `agw-implement` with a catch-all allow, plus `question` and `external_directory`
denied). `agw-readonly` allow-lists `shell` commands (`READ_ONLY_SHELL_RULES`, re-denies after
the allows, then trailing denies for command text naming `OPENCODE_SERVER_PASSWORD`, `IU_KEY`,
`IU_OPENAI_BASE`, the server port or `/api/session` — a cost-raising deny list, not a boundary,
see `docs/opencode-v2.md`; `edit: deny` alone does not stop a shell redirect) and denies
`subagent` (a subagent runs under its own, broader permissions). `agw-check` (a `readOnly` session that passes `runsChecks`, i.e. the `check` worker) is `agw-readonly` plus the build/test runners (`make`, `bun`, `uv`, `pytest`, `ruff`, `tsc`, …, a repo's `.venv/bin`/`node_modules/.bin`), with the server-self-access denies re-applied last; interpreters (`sh`, `bash`, `python -c`) stay denied and edits stay denied. (2) **The shell env is the
session's** — the shell tool starts from a sanitized base (the server's env does not reach it) plus
`PUT /api/session/{id}/environment`: the runner sends `extraEnv` (research-gateway credentials
included, so research validation works on OpenCode review angles), then `GIT_DENY_CREDENTIALS_ENV`
last, and blanks the server's credentials (`OPENCODE_SESSION_BLANKED_ENV`) as defense in depth.
(3) The working directory is `location.directory`. The wrapper
`scripts/agent-gateway-opencode-start.sh` (a shell script, same BTM reason as
`agent-gateway-start.sh`) refuses to start any opencode build but the pinned one and launches
`opencode serve` under `env -i` with only `PATH`/`HOME`/`TMPDIR`/`LANG` plus
`scripts/opencode-server-env.ts`'s output, so agw's own tokens (CLAUDE_*, GITHUB_TOKEN) never reach
a worker. `XDG_CONFIG_HOME` points at an EMPTY dir under the state root, so the operator's global
MCP servers never merge into a worker (a bare `mcp: {<name>: {enabled: false}}` does NOT suppress
one — measured 2026-10-13). **Never `--pure`** — measured 2026-09-24 to hang. **Before every
session** `runOpencodeAttempt` checks the IU endpoint AND `getOpencodeServerStatus()` (`GET
/api/info` for the version, plus an authenticated `GET /api/session/active` that must be 200 —
`/api/info` is public and cannot prove the password; no cache); a server that is down, rejects
the password or is not the pinned version fails the attempt as a transport-class failure without
a session (retry ladder, Max fallback and breaker apply), and so does a connection error mid-run.
It is also in `GET /api/jobs/health` as `opencodeServer: {ok, up, version, pinned, versionOk,
error?}` — not-ok makes the payload `pageable` (reason + warning) but leaves the queue's `ok`
alone — and `make verify` fails on it. `GET /api/config` on the server returns the IU key in
plaintext: loopback only, never log a response body.

**Usage, liveness, cancel (Wave 3).** Tokens and cost come from the `assistant` messages
(`summarizeOpencodeMessages`, paginated `order=asc` + `cursor.next` until an empty page — a single
page silently loses a long episode); every turn has its own message, so there is no lost final turn
and `usageIncomplete` is gone (the runner sets a `title` on create, which removes the background
title call that otherwise bills the session ~0.00009 USD without a message). The idle watchdog (`IDLE_TIMEOUT_MS`, 5 min) keys off
a fingerprint of the newest messages (`opencodeActivityFingerprint`; a provider retry is NOT
progress) polled every 3 s while a `wait` long-poll is open; the SSE stream is not used. An in-loop poll, finish check or `wait` that only times out is tolerated (`session.opencode_poll_slow`, retried next tick): the idle watchdog is the only kill. Cancel and
drain reach a session through `trackExternalSession` (`terminateSessionsForJob` /
`terminateActiveSessions` call its `stop`, which `POST …/interrupt`s it); any exit that did not
end idle on its own is interrupted too (a session keeps running tools otherwise — measured), and
`session.opencode_interrupt` is logged. `bun scripts/opencode-live-probe.ts` proves the whole path
against the real server. The pinned build is an npm install under `~/.local/share/agent-gateway/opencode-bin/<version>` (Homebrew's bottle lags, and is uninstalled: `scripts/opencode`, linked by `make install-cli`, puts this one build on PATH for `oc`, `rd … --kind opencode` and every pane); never swap it without the gate in `docs/opencode-v2.md`;
a server restart (`make install-opencode-agent`, refuses while jobs run) kills the episodes
running on it. There is no `database is locked` retry — the server owns the db.

**A dead IU endpoint must never hang an OpenCode session.** The server retries connect errors
and 5xx forever. `runOpencodeAttempt` therefore probes the IU OpenAI base (`fetch`, abort after
`AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS`, default 5000; any HTTP response counts as reachable)
before every session and, on failure, returns a connection-class error without creating one — the
existing retry ladder, Max fallback and circuit breaker read it as a transport failure
(`opencode-runner.ts`, `preflightIuEndpoint`). Mid-run there is no extra budget: provider retries
are excluded from the activity fingerprint, so the 5 min idle watchdog is the backstop. Any
manual or worker probe uses **`opencode-safe`** (`scripts/opencode-safe`, linked by `make
install-cli`): `curl --max-time 5` against the IU base (`IU_OPENAI_BASE`, else `IU_BASE_URL`,
else the `claude-sdk-base-url` Keychain item), then `exec timeout ${OPENCODE_SAFE_TIMEOUT:-120}
opencode …`; exit 75 when unreachable. Never a bare `opencode run`.

**Claude Max account pick (2026-10-24, dotfiles `docs/claude-accounts.md`).** Two Max subscriptions share
the mini. Each `claude -p` attempt on the `max` backend asks `claude-account pick --lane agent-gateway:<tool>`
(`pickClaudeAccount`, worker-shared.ts; 5 s cap, binary `~/.local/bin/claude-account` or
`AGENT_GATEWAY_CLAUDE_ACCOUNT_BIN`) and sets (`export`) or deletes (`unset`) `CLAUDE_CONFIG_DIR` in the
worker env; any picker failure = today's inherited env. Exit 3 ("no account has headroom") takes the
existing `max`→`iu` fallback, only where the route declares an `iu` fallback. A worker whose
`CLAUDE_CONFIG_DIR` is set never carries `CLAUDE_CODE_OAUTH_TOKEN` (it would override that account's login).
A quota-flavoured failure with no output on a picked account makes `planNextAttempt` return `account-retry`:
`runSession` runs `claude-account exhausted --account <id> --until <resets_at | now+1h>`, re-picks once
(the other account, or `iu`), and only a second wall reaches the IU fallback. The account id rides in the
`session_env` line as `account`. A claude session id is pinned to its account the moment it is known
(sidecar `~/.local/state/agent-gateway/session-accounts/<sessionId>.json`, `AGENT_GATEWAY_SESSION_ACCOUNTS_DIR`,
pruned after 30 d): a `--resume` / crash re-run reuses that `CLAUDE_CONFIG_DIR` (prompt cache is per account)
unless `claude-account usage --json` shows the account exhausted, then it re-picks. The re-pick after a
wall excludes the exhausted account: if the picker still returns it, the attempt goes straight to `iu`.
Spill with no `iu` fallback never falls through to the inherited env: the default account is set
explicitly, and if that is the walled account the attempt fails as a quota failure without spawning
(`resolveAttemptAccount`). Spill with a fallback is counted (`no-account-headroom`). A re-pick keeps
`--resume` (`projects/` is shared across the config dirs; only the cache is cold) and rewrites the pin.
Only a definitive wall (`isDefinitiveQuotaError`: a named usage window — 5-hour/weekly/session/daily/usage limit — or the `limit reached|<epoch>` suffix; a bare "limit reached" is rate-limit text, generic "quota exceeded" is not a wall) marks an account exhausted
or triggers the account retry; a transient 429/529 goes the old IU-fallback way. The `claude-account` CLI
gets a minimal env (`PATH`, `HOME`, `TMPDIR`, `LANG`, `CLAUDE_CONFIG_DIR` where needed); a failed pick
logs `session.account_pick_unavailable`, a failed exhausted mark `session.account_exhausted_mark_failed`.
A pick whose account id cannot be resolved fails closed once an account is excluded (`iu`, or no-spawn
when there is no fallback). `CLAUDE_CODE_OAUTH_TOKEN` is dropped for a dir this code (or `extraEnv`) set, and when the pick unsets
an inherited dir; an inherited dir left alone keeps its token. Both walled accounts are marked exhausted (the
second one before the iu fallback, which a definitive wall reaches too), and a failed picker with a walled
account to avoid takes the iu fallback when the route has one. Pins are validated on read (non-empty account, existing dir) and
swept by `pruneSessionAccounts()` (regular `<id>.json` only, once per process before the first write).
Reset epochs are clamped to now+7d. Exit 3 is a spill only for `pick`. `__setSpawnForTests` stubs the
`claude -p` spawn.
The spill signal is exit code 3 (stdout `spill`, or `iu` from an older picker; stdout is not keyed on).

**`otel` also injects the real ClickStack/HyperDX MCP** (bearer-authed
`http` server) into its own worker session — key resolution fails soft
(local `.env`, then `HYPERDX_PROD_ACCESS_KEY`, then `secrets-run` — never a
bare `op`, hangs headless); `readOnly: true` plus mutating tool names in
`extraDisallowedTools` keep it query-only.

Two constraints carried over regardless of backend:

- **No `WebSearch`/`WebFetch`** — workers shell out via Bash instead
  (`review` angle workers `curl` the research-gateway, async submit + poll).
- **Read-only tools must opt in** (`readOnly: true` →
  `--disallowedTools "Write,Edit,NotebookEdit"`). **It must be
  `--disallowedTools`, never `--allowedTools`** — under
  `--dangerously-skip-permissions` an allowlist restricts nothing (measured
  on CLI 2.1.220 — a probe overwrote its canary). `check`/`review` are
  read-only; `dispatch` is read-only in `investigate`/`author`, writable
  only in `implement`.

### Triage — single-shot, no worker session

`triage` (`server/jobs/handlers/triage.ts`, MCP tool + `agw triage
--prompt-file F --schema-file F`) is one tool-less completion, not a session:
`singleShotJson` (`server/lib/single-shot.ts`) calls `textComplete` over the IU
OpenAI transport on route `triage` (`transport: "iu-openai"`, the cheap IU model,
no fallback — like `adversary`), with `response_format: json_object` when the
registry says the model supports it and `max_completion_tokens` ≥
max(16000, registry `minOutput`). The caller supplies `{ prompt, schema }` where
`schema` is a JSON Schema (top level `type: "object"`), compiled with zod's
`z.fromJSONSchema` (zod 4, "semi-experimental"); the answer is parsed (a
` ```json ` fence is tolerated) and validated, re-asked ONCE with the
rejection reason appended, then the job fails. Result: `{ result, model,
latencyMs, usage?, attempts }`. The caller's prompt is the task itself, so it is
NOT fenced as DATA (`prompt-fence.ts` would tell the model to ignore it); the
output contract comes after it and the answer is machine-validated. Boot recovery
re-queues it once, like `check`. `review`'s angle router runs on the same helper
(route `review_router`, diff inline in the prompt, fail-soft to no extra angles).

### Dispatch — bounded episodes inside another repo

The `dispatch` job hands ONE episode to a worker session running inside a named
repo — an OpenCode worker by default (harness per route, see `GET /api/routing`).
The Claude harness (`claude -p`) is explicit opt-in: `AGENT_GATEWAY_HARNESS_DISPATCH=claude`
paired with a Claude `AGENT_GATEWAY_MODEL_DISPATCH`, the `kind: "editorial"` param (route
`dispatch_editorial`: AGENTS.md/docs/prose briefs run on a Claude model), or the automatic
Max reverse fallback after an IU failure — so it works with that
repo's own `AGENTS.md`/`CLAUDE.md`/rules/skills in context. Callers are warden and
interactive sessions; an observer like Hermes files work through `warden run`, not
directly. One episode, one verdict. Mid-run, the caller can inject new facts
with `job_steer` / `agw steer` (a running OpenCode episode only); anything beyond that —
redirecting the whole task — is an `rd wave` tab + `rd say`, not this.

**Tiers.** `investigate` (read-only → verdict), `author` (read-only → verdict

- issue), `implement` (write → verdict + branch + **draft** PR). The artifact
  follows the origin: a `github.com` remote gets the GitHub API path, a
  `gitlab.com` remote gets `glab` (draft MR = "Draft: " title prefix, issues via
  `glab api`); any other host is refused ~25 ms into the episode, before a
  worktree exists.

**Workspace** (implement only): `worktree` (default) = the isolated-worktree
path above. `in-place` = the episode edits the repo's **live checkout**
directly; the handler creates no branch, no commit, no push, no PR and
resolves no GitHub identity — the result carries outcome `applied_in_place`
and `changedFiles` (uncommitted, for the owner to review and commit). Refused
for any tier but `implement` and for `sensitive: true`; at most one in-place
episode per repo at a time. What it gives up: no worktree isolation and no
settings strip (the repo's `.claude/settings.json` `env` **does** apply —
accepted for the owner's own audited repos; `disableAllHooks` still holds).
On the opencode harness specifically, in-place instead **refuses outright**
(`assertInPlaceOpencodeConfigAllowed`, dispatch.ts) when the live repo root
carries `opencode.json`/`opencode.jsonc`/`.opencode/` — a plugin there
executes code regardless of permissions, and there is no worktree to strip
it from first; worktree tiers still get the ordinary strip/restore.
What still holds: `GIT_DENY_CREDENTIALS_ENV`, the fence, the CI-path and
added-secret scans (a hit is a warning in the verdict, not a discard — nothing
is published), the repo's own `check` before the verdict (reported, never
gating). Pre-existing uncommitted work is snapshotted before the episode and
excluded from `changedFiles`; never reverted, stashed or committed by the
handler. Never auto-resumed on boot (`interrupted` instead) — no worktree to
reconstruct and no durable snapshot to attribute a re-run against.

**Revisions, rebase, `update_pr`, lease** (2026-10-02). `revisionOf: <dispatch/* branch>`
(implement + worktree only) makes the **handler** fetch that branch and cut the
worktree from its tip — the worker never fetches; the push is `--force-with-lease`
pinned to the fetched tip and the existing open PR is updated (`pr_updated`), no new PR.
Every implement push first rebases onto a freshly fetched default branch (fetch must
succeed); a conflict aborts, bundles the commits into the salvage dir and returns
`conflict` — the caller re-dispatches, nothing is hand-resolved. **`update_pr {cwd, pr}`**
(job tool, MCP tool, `agw update-pr --pr N`) is the same rebase + checks + lease push
for an open same-repo `dispatch/*` PR targeting the default branch → `{status:
updated|up_to_date|conflict, headSha, checks}`; checks are skipped when nothing moved and a
red result is still pushed (the merge train reads `checks`). **One implement-class episode
per repo at a time, across every caller** (`server/lib/repo-lease.ts`, in-process map —
exact because the server is single-process): worktree, in-place and `update_pr` all take it;
a second **queues** (`pending`, `queuedBehind: <holder jobId>`, FIFO per repo, promoted when the holder finishes; lease-queued rows are excluded from `oldestPendingAgeMs`). Static refusals (policy, in-place/sensitive/`revisionOf` rules, bad `branch`/`prTitle`) are synchronous 400s at `POST /api/jobs` with no job row. Callers may set `branch` (`dispatch/<slug>`) and `prTitle`. `DISPATCH_SCHEMA_VERSION` is 7 (7 added the optional `escalationCategory`, `human` verdicts only: product | data_loss | spend | other_people | security | blocker; 6 added the optional `fallbackWithheld` output field and `branch`/`prTitle`/`kind` inputs; 5 introduced
`checks_tool_failed`, the repo's `check` tool throwing before it could grade the diff —
an infrastructure failure, re-run the dispatch — split out from `checks_failed`); warden's
pin moves with it.

**`sensitive`** opens `investigate` for secret-bearing repos (`dotfiles-private`,
`homelab-private`) — refused outright at any other tier, before a worktree
exists, since a filed issue or pushed branch has no safe artifact path there.
agent-gateway derives sensitivity itself from the repo policy below and ORs it with
whatever the caller still declares — a caller may opt a policy-neutral repo
into the scan, but can no longer opt a policy-marked one out of it by omitting
the field. The verdict is scanned (`assertSensitiveTierAllowed` +
`applySensitiveScan`, `dispatch.ts`) before it leaves the machine; a match
withholds `summary`/`verdict`/`evidence` behind a notice and keeps the full
text in an owner-only `~/.local/state/agent-gateway/private-verdicts/<jobId>.md`
(mode `0600`) instead. `readOnly: true` removes Edit/Write but **not**
`Bash`, and the brief is attacker-influenced — this scan is the actual
boundary for a sensitive episode, not the permission profile.

**Invariants** (full rationale + the mutation-verified test suite in
`docs/dispatch-security.md`):

- **Repo policy** (`server/lib/dispatch-policy.ts`, `GET /api/dispatch-policy`)
  gates every submission before it costs anything: `cwd` must resolve to a
  repo directly under a configured root, at or under that repo's tier
  ceiling. Only `dotfiles-private`/`homelab-private` (sensitive) and
  `brain` default below `implement`; every other repo (`hermes-agent` included),
  including `agent-gateway`, `warden` and `dotfiles` themselves, is
  `implement`-reachable by default. `AGENT_GATEWAY_DISPATCH_CEILINGS`/`_SENSITIVE`
  can only narrow, never widen, any repo's rule (marking a repo sensitive
  clamps its ceiling with it). **`AGENT_GATEWAY_DISPATCH_ROOTS` is the exception
  — it REPLACES the roots rather than narrowing them**, so a new tree there
  is dispatch-reachable at the permissive default. Checked in both
  `server/routes/jobs.ts` (at submit) and `runDispatch` (belt and suspenders
  for a direct caller) — it is a policy boundary on repo/tier, not a sandbox.
- Every tier runs in its own worktree, torn down in a `finally`; read tiers
  are cut from the repo's remote default branch, falling back to a detached
  copy of HEAD when the origin is absent or unreachable (`base: "head"` opts
  into the live checkout explicitly).
- Read tiers also materialize untracked/gitignored files (bounded, symlinks
  never followed) — the read exposure was never about copying files _in_.
- Boot sweeps every stale worktree/branch left by a SIGKILL.
- The artifact (issue/branch/PR, on the origin's forge) is created by the
  **handler**, never by the worker session — the session holds no forge
  credential.
- `GIT_DENY_CREDENTIALS_ENV` at every tier — this host's `~/.gitconfig`
  wires a credential helper any process can use, and a read-only session
  still has `Bash`.
- `--settings '{"disableAllHooks":true}'` on every claude-harness worker, and
  `.claude/settings{,.local}.json` **and** (2026-09-24, the opencode harness)
  `opencode.json`/`opencode.jsonc`/`.opencode/` are stripped from the
  throwaway worktree before the episode and restored **from the pinned base**
  after — an audited repo's hooks/`env`/plugins must never execute inside the
  episode.
- `implement` refuses `.github/workflows` diffs and added lines matching
  `SECRET_PATTERNS`; commits `--no-verify`; opens a **draft** PR (GitHub) or
  a "Draft: " MR (GitLab) against the forge-resolved `default_branch`. The
  repo's `check` runs before the push; a red
  format/lint/typecheck/test withholds the PR (`checks_failed`), a red
  `fallow` step alone never does — it audits whole touched files, so it rides
  along in the PR body as advisory instead.
- The brief is untrusted and fenced with per-run nonce delimiters, re-asserted
  after the data block.
- A per-job `model` that is not a verified registry model is refused at
  `POST /api/jobs` with 400 `dispatch refused: model <id> is not a verified
registry model` (`withModel` alone would silently keep the default).
- Salvage retries only a serialization failure (fresh session, no `--resume`)
  and marks it `degraded: true`; a real failure throws.

### Decide — a decision model, not a language model

`decide` (`server/jobs/handlers/decide.ts` → `server/lib/decision.ts`) is one call to an IU
**decision model** (`GET <origin>/decisions/v1/models`; default `pplx-decider-v1-27b`, override
`AGENT_GATEWAY_DECISION_MODEL`, per job `model`): the AI SDK's experimental `decide` through
`@ai-sdk/typesafe-ai`, mirroring email-gateway's Jev lane. Input `{state, questions, model?}` —
`state` is plain text, each question a `choice` (`options` id → description, ≥ 2) or `boolean`. Output
`{answers, model, latencyMs, usage, truncatedChars}`; a choice answer carries `confidence`
(the provider's calibrated per-question value from `providerMetadata.typesafe.confidence`, NOT the
option probability) plus `probabilities`; a boolean carries `value`/`probability`. The model
generates no text and cannot search or read anything: **the caller's `state` is its whole world**,
so context quality is the caller's job (warden builds it, `lifecycle/shadow.py`). `DECISION_MODELS`
(decision.ts) holds each known model's rate and a conservative `maxStateChars` cap; the state is
cut to it and `truncatedChars` says how much. Cost is computed from the rate (the provider drops
IU's own `usage.cost`) and recorded to the `agent-gateway-iu` sink as tool `decide`. Reach:
MCP tool `decide` (a new tool: `/mcp` reconnect), CLI `agw decide --state-file F --questions-file F
[--model M]`, or `POST /api/jobs {tool:"decide"}`. Boot recovery
re-queues it once, like `triage`. The single request has a 30 min hang guard (agent-limits rule),
no retry here — the caller owns retries.

### Review — multi-angle pipeline

The `review` job (`server/jobs/handlers/review.ts`) runs a 3-phase parallel
pipeline: data gathering (git diff, `fallow review --brief` with a scope-derived
`--base` — `fallowBaseFor`, never `audit`'s auto-detected merge-base, which
is wrong on this direct-to-master repo for an already-pushed scope) → angle reviews (parallel Claude sessions, capped at
`ANGLE_CONCURRENCY=3`: architect, senior-dev, + conditional
frontend/backend/typescript/QA, plus router-picked content angles
security/performance/concurrency/data-migration/api-contract/resilience
against an ISO 25010 checklist, plus a non-agentic adversary
critic) → synthesis (the `review` route's model — Haiku 5.5 EU on OpenCode by default, Sonnet on Max as fallback; classifies into
`blocking`/`improvements`/`discussions`/`testGaps`). `outcome`: `"clean"` /
`"actionable"` / `"needs-human"`, **derived in code after the synthesis JSON is parsed**
(`applyVerdictRules`, review.ts; a differing model outcome is logged `review.outcome_override`):
`needs-human` on any discussion or failed angle, else `actionable` iff `blocking` is non-empty,
else `clean` — improvements (capped at 5, the rest noted in the summary) and test gaps are
optional follow-ups, never a reason to re-review. Blocking means a demonstrated defect in the
changed lines that the synthesizer confirmed at the cited `file:line`; an unconfirmed
adversary claim is dropped or an `Unverified:` improvement. Each angle session gets **one pipeline-level
retry** on failure (`ANGLE_MAX_ATTEMPTS = 2`), because `session-runner` retries
only transport-class errors — an idle-watchdog kill on a session route
would otherwise be final and force the whole review to
`needs-human`/`blocker` on a single flaky attempt; only a second failure stands
(logged `review.angle_retry`). Full pipeline docs, angle tables and cost
profile: `server/skills/review/README.md`.

**react-doctor:** an advisory phase-1 input like fallow's brief, never a gate
(`server/lib/react-doctor.ts`, rendered into synthesis's `[REACT_DOCTOR_RESULTS]`,
logged `review.react_doctor`). No repo installs it — `REACT_DOCTOR_VERSION` is
installed once under `~/.local/share/agent-gateway/react-doctor/<ver>/`
(`scripts/install-react-doctor.sh`, `make install-react-doctor`; `make deploy` and
`make install-cli` run it best-effort, a failure only makes reviews report "not run")
and the command execs `node_modules/.bin/react-doctor` there by absolute path
(`reactDoctorBinPath()`), diff-scoped (`--scope changed`, the base from
`fallowBaseFor` resolved to an OID, since it rejects `~`/`^`), only when a tracked
`package.json` lists `react`. **Never `bunx`**: its shared install cache races under
concurrent reviews (`Failed to link <pkg>: EEXIST`, 73 of 520 runs failed, measured
2026-10-19). Upgrade: bump `REACT_DOCTOR_VERSION`, run `make install-react-doctor`.
**`--no-telemetry` is mandatory** (it skips their remote score API; the command
also passes `--no-supply-chain`, which skips Socket.dev lookups) — never send repo
data off the machine. Noisy/overlapping rules are filtered in code
(`REACT_DOCTOR_DROPPED_RULES`); a crash or timeout renders an explicit
`react-doctor failed` line (reason = exit code + the first error-looking line of the
last 15 stderr lines, ≤600 chars), never silence. Angles do not receive it.

**OpenCodeReview (OCR):** one more phase-1 input, started right after Phase 1
confirms real changes and awaited only just before the synthesis prompt is
built, so its ~2.5 minute wall time runs parallel with the router + angle
phases instead of adding in front of them (`server/lib/ocr.ts`, route
`review_ocr` — the cheap IU model over IU's OpenAI route with `--effort low`,
picked by a same-range bake-off, rationale in `routing.ts`; per-token, off Max; no Max fallback,
since it's an external CLI, not a `runSession` worker). Fails soft to a
one-line skip/fail block the synthesizer reads like an unavailable
fallow — never a gate, never thrown into the review. Disable with
`AGENT_GATEWAY_REVIEW_OCR=0`. Runs only at review depth `deep` (router-judged, gating default-on; `AGENT_GATEWAY_REVIEW_DEPTH_GATING=0` restores always). Skipped below 100 changed diff lines
(`AGENT_GATEWAY_REVIEW_OCR_MIN_LINES`, 0 = always): on the 111-review corpus it filed 0
blocking findings under 100 lines at full cost (~3 min, ~$0.06 — it explores the repo
either way), and 9 in the 74 reviews above. Also skipped above 30 changed files
(`AGENT_GATEWAY_REVIEW_OCR_MAX_FILES`, 0 = no cap; ~0.23 M prompt tokens per file, $2-3 per run past 30). Paused until 2026-11-02 (IU cap cooldown, `AGENT_GATEWAY_REVIEW_OCR_PAUSED_UNTIL`, empty = no pause; delete `OCR_PAUSED_UNTIL_DEFAULT` after expiry). The IU key is handed to the third-party `ocr` binary
via env — accepted because its agent tools are read-only (file read/find/
search via `git`, no shell tool) and it reads LLM config only from env/
`~/.opencodereview`, never the repo; a repo's own `.opencodereview/rule.json`
can inject review-rule text into the prompt, not redirect the endpoint. OCR
also runs outside `ANGLE_CONCURRENCY` — one extra IU stream per review,
accepted.

**External-fact validation (optional):** with `RESEARCH_GATEWAY_URL` +
`RESEARCH_GATEWAY_TOKEN` set, each angle prompt gets a bounded `curl` recipe
to validate an external library/API/version claim before filing it.

**Synthesis salvage:** the synthesizer occasionally emits prose instead of
schema JSON. It retries once with a JSON-only directive, then falls back to a
`needs-human` verdict preserving the raw text (`SessionResult.rawText`) — a
multi-minute run is never discarded as a bare parse error.

### Multimodal tools — direct IU OpenAI transport (synchronous)

`read_image` and `read_drawing` are **not** `runSession()` worker sessions
and **not** async jobs — plain `fetch` calls to the IU unified endpoint's
**OpenAI transport** (`/openai/v1/...`), stateless, single call well under
the 60s SDK timeout. Billed IU per-token, zero Max.

- Credentials (`server/lib/iu-openai.ts`): Keychain (`claude-sdk-api-key`,
  `claude-sdk-base-url`) or `IU_API_KEY`/`IU_BASE_URL` env; OpenAI base
  derived from the Anthropic base (`/anthropic` → `/openai/v1`).
- Model defaults to a fast vision model (see `GET /api/routing`) — a non-EU vendor, fine for
  git-committed/non-sensitive content, not PII — overridable via
  `AGENT_GATEWAY_MODEL_READ_IMAGE`/`AGENT_GATEWAY_MODEL_READ_DRAWING` like every other
  routed tool (`server/lib/routing.ts`); a `AGENT_GATEWAY_BACKEND_*` override is
  refused instead, since these run over the fixed `iu-openai` transport.
- `read_image` — vision read of any image (SVGs rasterized first via headless
  Chrome, `server/lib/chrome.ts`). Sampled at the provider's default
  temperature — no `temperature` on the wire, since the gateway 503s on a
  non-default value for the OpenAI GPT family and VISION may be re-pointed there.
- `read_drawing` — composite: rasterize+read the `.svg` AND deterministically
  parse the paired `.excalidraw` JSON, merged into one synthesis. Retires the
  dotfiles `/read-drawing` skill's `claude_iu` path.
- `generate_image` was retired 2026-07 in favor of the `image-gen` gateway.
- These bypass `session-runner`, so usage is logged separately:
  `~/.local/share/usage-tracker/agent-gateway-iu.jsonl` (`recordIuUsage`), ingested
  by usage-tracker's `agent-gateway-iu` collector. Reasoning tokens (Gemini bills
  thinking spend outside `completion_tokens`) are derived via
  `normalizeUsage`, not reported by the gateway — dropping this understated
  cost several-fold. `cost_usd` is written only when the gateway reports `usage.cost`;
  otherwise it stays null and usage-tracker prices the row from its own table (off-peak
  aware) — it treats any numeric `cost_usd` as reported, so never write an estimate here.

```bash
# Register at user scope — handled by `make setup` in ~/SourceRoot/dotfiles.
# Manual fallback:
claude mcp add --scope user agent-gateway -- bun run "$HOME/SourceRoot/agent-gateway/server/mcp.ts"

# Structured logs (both HTTP + MCP processes write here)
tail -f ~/Library/Logs/agent-gateway.jsonl | jq .
tail -f ~/Library/Logs/agent-gateway.jsonl | jq 'select(.source == "mcp")'
```

Inner sessions spawned by MCP tools use `claude -p` via `session-runner.ts`,
model and backend per tool from `server/lib/routing.ts` (`GET /api/routing`).
See `.claude/rules/mcp-tools.md` for authoring conventions.

## Git Workflow

Direct-to-master repo — no PRs, no releases.

```
/review   → optional code review before committing
/commit   → commit, then push to master directly
/ship     → review → commit → push (skips PR and release steps)
```

Never create feature branches or PRs for this repo.

## Project Skills

Project-specific skills live in `.claude/skills/` (tracked in git, unlike most repos).
Settings files (`.claude/settings.json`, `.claude/settings.local.json`) remain gitignored.

| Skill        | Purpose                                                             |
| ------------ | ------------------------------------------------------------------- |
| `claude-cli` | Reference for spawning `claude -p` subprocesses from Bun/TypeScript |
