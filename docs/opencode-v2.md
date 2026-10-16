# OpenCode v2 server mode — measured facts, design, upgrade gate

Spec order for this migration: `docs/waves/archive/2026-10-opencode-v2.md` (the archived plan) > this file > dotfiles
`docs/agent-platform.md` > older docs. Everything under **Measured** was observed on
**opencode 2.0.25** (then Homebrew; re-probed on 2.0.29 on 2026-10-15, the pinned build since) with `scripts/opencode-v2-probe.ts` on 2026-10-14; the probe is
the executable form of this page and the upgrade gate (below).

**Status: Wave 4 shipped (2026-10-14).** An episode is a session on one agw-owned OpenCode v2
server (`com.jkrumm.agent-gateway-opencode`, `server/mcp/opencode-server.ts`), driven over HTTP by
`runOpencodeAttempt` through the `OpencodeClient` port (`server/mcp/opencode-client.ts`): create →
environment → prompt → wait → messages. No `opencode run` child process, no NDJSON parser, no CLI
fallback. Since Wave 4 a drain detaches a dispatch's session (it keeps running on the server), the
next boot re-attaches it, and `POST /api/jobs/:id/steer` injects new facts into a running episode.
Since Wave 9 that holds for EVERY OpenCode session run under a job (in-place dispatch, review
angles, any other OpenCode-harness tool): a reload no longer waits for them (§ Durability).

## Measured

The probe starts a **dedicated** `opencode serve` (own port, own `XDG_*` roots, own
`OPENCODE_DB`, IU credentials from agw's env) so it never touches the shared per-user service.

| Question | Result |
|-|-|
| Boot | ~160 ms to answer `GET /api/session/active` |
| Auth | HTTP Basic, username must be `opencode` (any other gets 401), `OPENCODE_SERVER_PASSWORD` as password. No header = 401 |
| Flow | `POST /api/session` → `POST /api/session/{id}/prompt` → `POST /api/experimental/session/{id}/wait` (204 when idle) → `GET /api/session/{id}/message` |
| Session create | `{location:{directory}, model:{providerID,id,variant?}, permissions:[{action,resource,effect}], metadata, agent, title}`. Directory is honoured; the shell/read tools run there |
| Messages | Newest first by default. Types `user`, `assistant`, `idle`. The `idle` message carries `outcome`: `succeeded` or `interrupted` |
| Usage | Every `assistant` message has `tokens{input,output,reasoning,cache{read,write}}` and `cost` (USD, from the config's `cost` rows). A turn that ends in a tool call has its own message, so **no final-turn loss** — `usageIncomplete` has no analogue here |
| Session rollup | `GET /api/session/{id}` `cost`/`tokens` is **greater** than the sum of the assistant messages by ~0.0004 USD / ~600 tokens per short session: a background call billed to the session without a message (presumably title generation), settling a moment after `wait` returns. Per-turn attribution sums messages; total spend reads the settled rollup |
| Pagination | Default page **50**, `limit` max **200** (400 above). Walk `order=asc&limit=N`, then `cursor=<cursor.next>` until a page is empty. `cursor.next` is present even on the last page, so "no cursor" is not the stop condition. A runner that reads one page silently loses usage on any long episode |
| Concurrency | 5 sessions in 5 git worktrees on one server, concurrently: 3.6–5.3 s wall, each file landed in its own worktree, no cross-leak, **no "database is locked"** |
| Interrupt | `POST /api/session/{id}/interrupt` → `{interrupted:true}`, idle in ~25 ms with `outcome: interrupted`, killing the running `sleep 60`. Session accepts the next prompt. On an idle session: `{interrupted:false}` |
| Steer | `prompt {delivery:"steer"}` (the default) into a running turn: the model changed its final answer from ALPHA to BRAVO mid-`sleep`. `delivery:"queue"` runs the second prompt after the first finishes (output `ALPHA` then `BRAVO`, 3 assistant messages) |
| SIGKILL mid-tool | Session and messages survive in `opencode.db`. The running tool stays `streaming`/`running`, no `idle` message, `GET /api/session/active` is empty — **the server does not resume by itself**. `prompt {resume:true}` re-attaches and the episode finishes (`after.txt` written, `outcome: succeeded`) |
| SIGTERM mid-tool | Exits in ~50 ms (not a drain). Interrupted tool recorded as `error`; same `resume:true` re-attach works |
| Permission `deny` | The tool is **removed from the model's toolset** rather than failing: with `shell` denied no shell call is attempted. `edit: deny` also removes `write` (not a separate action), and code-mode `execute` proxies through the same gates — a denied `edit`/`shell` inside `execute` writes nothing. `write` and `execute` are not permission actions |
| Permission `ask` | The session **blocks**: `GET /api/session/{id}/permission` lists the request, `wait` does not return, `POST …/permission/{requestId}/reply {decision:"once"}` (204) lets it through. Never leave an `ask` rule in an unattended session |
| Rule order | **Last matching rule wins.** `[shell * deny, shell "git status*" allow, edit * deny]` runs `git status` and rejects `echo X > f` as a tool `error` (session still completes). Reversed, the catch-all deny wins |
| `edit: deny` alone | Does **not** stop a shell redirect (`echo X > f` worked). The read-only profile must deny `shell` too and allow-list commands, as `buildOpencodeConfig` does today |
| SSE `GET /api/event` | `text/event-stream`, JSON `{id,created?,type,location?,data}`. Types seen for one tool turn: `server.connected`, `session.inbox.enqueued/delivered`, `session.execution.started/succeeded`, `session.step.started/streamed/ended`, `session.text.started/delta/ended`, `session.tool.input.started/ended`, `session.tool.called/progress/success`, `shell.created/exited`, `session.usage.updated`, `session.renamed`, plus ambient `*.updated`. Volatile by contract — liveness hint only |
| Config via env | `OPENCODE_CONFIG_CONTENT` is generated v2-native by `buildOpencodeServerConfig` (`providers`, `agents.*.permissions`, `package: aisdk:…`; the v1 `provider` form was dropped 2026-10-15, probe section `providers`). On 2.0.25 a v1-shaped config was normalized to v2 and worked unchanged. Config-defined providers do **not** appear in `GET /api/provider` or `/api/model`; sessions use them anyway (`model:{providerID:"iu-chat",id}`) |

## Measured in Wave 2 (`run --server`, 2.0.25, 2026-10-14)

| Question | Result |
|-|-|
| CLI surface (retired in Wave 3) | `opencode run --server URL` takes `--agent`, `-m provider/model#variant`, `--session`, `--format json`, `--file`, `--title`, `--auto`. No permission, env or config flag — the reason Wave 3 talks to the HTTP API directly |
| Permissions | A config `agents.<name>.permissions` (v2 rule array) plus `--agent <name>` enforces them: with `shell` denied, shell was unavailable. Agent rules are appended after the built-in base policy (allow all; ask on `external_directory` and `.env` reads), so each `agw-*` agent opens with a catch-all rule |
| Server config | `OPENCODE_CONFIG_CONTENT` on the server process (overrides a repo `opencode.json`). Auth: HTTP Basic, `OPENCODE_SERVER_PASSWORD` read by both server and client. `GET /api/info` carries `{version, pid, urls, paths}` and needs no auth (the status probe sends it anyway) |

v2 action names (https://opencode.ai/v2/docs/permissions): `shell` (v1 `bash`), `subagent` (v1
`task`), `read`, `edit`, `glob`, `grep`, `skill`, `question`, `webfetch`, `websearch`,
`external_directory`, `execute`. `list`, `lsp`, `todowrite` and `doom_loop` are not v2 actions
(an unnamed action falls to the catch-all). A **subagent runs under its own permissions**, not
its parent's, so `agw-readonly` denies `subagent` — v1's `task: allow` has no equivalent hole.
`agw-implement` allows it (its own base policy would `ask` on `external_directory` — watch for a
stalled episode).

**Session environment (Wave 3).** `PUT /api/session/{id}/environment` (`{variables:{…}}`, 204) sets
the shell env for that session; call it before the first prompt. The runner sends
`{blanks…, extraEnv, GIT_DENY_CREDENTIALS_ENV}` — so `RESEARCH_GATEWAY_URL`/`_TOKEN` reach OpenCode
review angles again and the git credential deny no longer rides the server's env. Measured on
2.0.25 (`scripts/opencode-live-probe.ts`): the shell tool starts from a **sanitized** env (`HOME
LOGNAME PATH PWD TERM` plus `OPENCODE_*` markers) — the server process's own env (`IU_KEY`,
`OPENCODE_SERVER_PASSWORD`, `XDG_*`, …) is NOT inherited, so the session `PUT` is the only channel,
and a blank value blanks a variable. `OPENCODE_SESSION_BLANKED_ENV` (password, IU key, IU base) is
sent blank anyway: defense in depth should a build start inheriting the server env; the probe
asserts the worker shell sees them EMPTY and prints whether an unblanked shell would have seen them.

**A session outlives whoever started it (measured 2.0.25).** A killed `opencode run --server` client
left the server-side session `running` (a file was written 40 s later). Wave 3 has no client
process, but the rule stands: any exit of the drive loop that did not end with the session idle on
its own (idle-watchdog kill, cancel, drain, a throw) calls `interruptOpencodeSession`
(`POST /api/session/{id}/interrupt`, best-effort, `{interrupted:false}` on an idle session) and logs
`session.opencode_interrupt`. `getOpencodeServerStatus` also requires an authenticated
`GET /api/session/active` = 200, because `GET /api/info` is public and cannot prove the password.

**Self-access: a deny list on command text, NOT a boundary.** The server's env (including
`OPENCODE_SERVER_PASSWORD` and `IU_KEY`) is inherited by every worker shell, and `curl` is
allowlisted for the read-only agent. The permission pattern matches the command TEXT while the
shell expands `$VAR`, so `curl -u opencode:$OPENCODE_SERVER_PASSWORD http://127.0.0.1:<port>/api/session …`
would let a read-only worker create a permissive session on this very server, or echo the IU key.
`agw-readonly` therefore ends its `shell` rules (after every allow — last match wins) with denies
for any command text containing `OPENCODE_SERVER_PASSWORD`, `IU_KEY`, `IU_OPENAI_BASE`, the server
port and `/api/session` (`serverSelfAccessDenyRules`). This only **raises the cost**: an obfuscated
expansion (`${!name}`, a name built up piecewise, a different spelling of the port) can evade
it, and `IU_KEY` being readable from a worker shell is pre-existing and accepted. `agw-implement`
has no such rules at all. Wave 3 closed the env route (above): the worker shell neither inherits nor is given the password
or the IU key, so what remains is a worker that reads the password FILE or guesses the port, and
this list is defense in depth against exactly that. The server password and IU key are redacted from every runner output
(final text, error message, stderr) like the IU key always was. `scripts/opencode-live-probe.ts`
checks the refusal (with the same command succeeding in `agw-implement` as control); it needs the
server reinstalled (`make install-opencode-agent`) to pick up new rules, as the config is
generated at server start.

## Security notes

- **`GET /api/config` returns the resolved provider `apiKey` in plaintext.** The server is
  therefore loopback-only with a password, never behind a tailnet or Caddy door, and nothing
  that reads it may log the body. The probe passes every printed and persisted line through a
  redactor for the IU key (`check`/`note`), since the spawned server's env holds it and a model
  can be asked to echo it; the 401 behaviour is itself a probe check.
- The password rides `OPENCODE_SERVER_PASSWORD` from a `0600` file, not argv.
- Worker sessions use only `allow`/`deny` rules (never `ask`), as today's profile does.
- Per-location project config (`opencode.json`, `.opencode/`) is still stripped from throwaway
  worktrees by the dispatch handler; `XDG_CONFIG_HOME` is pinned to an empty root on the
  server so the operator's global MCP servers never reach a worker.
- The server runs under `env -i`: only `PATH`/`HOME`/`TMPDIR`/`LANG` plus the generated env
  (`opencodeServerEnv`). agent-gateway's own tokens never reach a worker shell.

## Design (Waves 2–4)

**Transport: a thin typed `fetch` client, not `@opencode/client`.** `@opencode/client` 2.0.29
peers on `effect@4.0.1` and `solid-js`, has 1000+ published versions and shipped six patch
releases in the week of this measurement; `@opencode/sdk` is an in-process host with no
listener; `@opencode-ai/sdk` is the v1 line. agw needs ~10 operations (create, prompt,
wait, messages, interrupt, active, permission list/reply, session get). A zod-validated client
over those routes, in one module (`server/mcp/opencode-client.ts` in Wave 3), is smaller than
the dependency and moves only when the probe says the spec moved. The OpenAPI document is the
reference: `opencode api GET /openapi.json` (labelled experimental 0.0.1).

**Supervision: a separate LaunchAgent, not an agw child.** `com.jkrumm.agent-gateway-opencode`
(`KeepAlive`, `RunAtLoad`) runs a wrapper script (`scripts/agent-gateway-opencode-start.sh`, a
script for the same Background Task Management reason as `agent-gateway-start.sh` — see
`docs/deployment.md`) that execs `opencode serve --hostname 127.0.0.1 --port <fixed>`. Reasons:
- an agw `make reload` must not kill in-flight episodes — they are the thing Wave 4 re-attaches
  to, and agw's own SIGTERM window is capped at 60 s;
- a crash restarts without agw involvement, and agw only needs to *notice* (health) and re-attach;
- agw-as-parent would need pid adoption across its own restarts, i.e. reimplementing launchd.

State lives under `~/.local/share/agent-gateway/opencode/` (`cfg/ data/ state/ cache/` and
`opencode.db` via `OPENCODE_DB`) — never `/tmp` (same sweep reason as the logs). Credentials come
from the Keychain items `getIuConfig()` already reads; the config is generated from the model
registry (`buildOpencodeServerConfig`) once at server start, not per run.

**Per-run config is the session (Wave 3, shipped).** Model → `model:{providerID,id,variant}`; the
permission profile → `agent: agw-readonly|agw-implement` (rule arrays in the server config,
catch-all first, last match wins); worktree → `location.directory`; per-job env → `PUT
…/environment`; `title: "agw <tool>"` and `metadata.agw.{jobId,tool}` (the handle Wave 4's
re-attach reads). Messages are read through `OpencodeClient.allMessages` (asc, paginated) and
`recentMessages` (desc, the liveness probe).

**Usage and liveness (Wave 3, shipped).** Usage is summed from the assistant messages
(`summarizeOpencodeMessages`: exact tokens and cost per turn, so no lost final turn and no
`usageIncomplete`); with a `title` set on create the settled session rollup equals the message sum
(without one a background title call adds ~0.00009 USD). The idle watchdog fingerprints the newest
messages every 3 s (`opencodeActivityFingerprint`: ids, content lengths, tool states, tokens —
NOT the provider `retry` field, so a dead endpoint's retry loop is not progress) while one `wait`
long-poll is open; SSE is not used. A `wait` that returns before a freshly admitted prompt has
started is re-checked until the newest message is a new `idle`. In-loop requests (activity poll,
finish check, `wait`) that merely time out are tolerated — logged `session.opencode_poll_slow`
and retried next tick, since a heavy tool can make the server answer a short request late — so
the idle watchdog is the only kill; a refused connection or an HTTP/schema error still fails at
once. A running shell tool part changes nothing in the message stream, so while one is `running`
(`state.metadata.shellID`, 2.0.29) the watchdog also reads `GET /api/shell/{id}/output?location[directory]=<dir>&limit=1`:
`data.size` is cumulative and grows live as the command prints (measured to 4.5 MB, `truncated: false`).
Every running shell is tracked by id; growth of any one past its last known size is activity; an
unchanged size, an unknown one (a failed read or poll) is not. A command that never exits but keeps
printing (`tail -f`) therefore holds its lane until `job_cancel` — by design: output is the liveness
rule and there is no volume or wall-clock ceiling (`dotfiles/rules/agent-limits.md`). Cancel and drain call the session's registered `stop` (`trackExternalSession`), which
interrupts it.

**Durability (Wave 4 for dispatch, Wave 9 for every session under a job).** A drain detaches an
OpenCode session instead of interrupting it, at the START of the drain
(`createShutdownController.begin()` → `detachRemoteSessions()`, session-runner.ts): the session is
not interrupted, keeps running on the shared server, `SessionDetachedError` is thrown out of
`runOpencodeAttempt`, the owning jobs get a durable `detached_at` marker, and the drain waits only
for the jobs it cannot detach (`drainBlockers`: `claude -p` sessions — also next to a detached
OpenCode one in the same job —, check steps, single-shot requests, jobs between phases). Only a session
a caller can hand back detaches (`canDetachSession`: a job id plus `reattachKey` or `onSessionId`); a
repo check run for dispatch / `update_pr` and excalidraw are interrupted as before. A detachable
session registered after the drain began (or an attempt that starts then, re-checked right before
`createSession`) detaches before creating anything; one detached between its creation and its prompt
sends no prompt. A job cancel (`stop("cancel")`) still interrupts; so does a session with no job id. A detach skips the post-run message read: the attaching attempt reads the whole
session, so nothing bills twice.

Re-attach is by state, identical for every caller (`runOpencodeAttempt`): the session is in
`GET /api/session/active` → wait only (no prompt, no environment call); newest message is a
non-failed `idle` → it finished while agw was down, read the result; otherwise, when it has
messages (cut off, e.g. a killed server) `prompt {resume:true}` with `SessionOptions.resumePrompt`
(the continuation nudge); with no message at all (detached before its first prompt) the FULL `prompt`
goes out as a first prompt. A ledger session is replaced only on a definite HTTP 404; any other read
error rethrows as a transport failure (retry ladder). `session.opencode_reattach` logs the mode (and `fromLedger`). Who hands
the session id back:

- **dispatch** — the job row (`session_id` via `onSessionId`, plus `worktree_meta`); `recover()` keeps
  both and the handler passes `resumeSessionId` with the continuation nudge. Worktree episodes skip
  salvage and teardown on a detach. **In-place** episodes resume too: their `worktree_meta` marker
  persists the pre-episode `InPlaceSnapshot` (`{ path, workspace: "in-place", snapshot }`), so the
  re-attached run attributes `applied_in_place` edits against the same baseline; without a persisted
  snapshot (a row from before this change) or without the detach marker (a crash — the session may be
  gone and the per-repo lease was process-local) the row stays `interrupted`, edits left uncommitted.
- **every other detachable tool** — the **session ledger** (`job_sessions`): `SessionOptions.reattachKey`
  is the key, used as is. The persisted ROW decides, never a counter, so keys cannot shift across a
  restart: `runOpencodeAttempt` re-attaches the row for the key if there is one and creates (and
  records) a session otherwise. A finished attempt `settle`s its row (usage already attributed → a
  re-attach writes no second row); a failed one drops it, so at most one row per key survives and it
  is the session to continue — no live session is left unreferenced, and a transport-retried attempt
  re-attaches the same session. A second `runSession` call under the key in the SAME process is a
  handler-level retry (a JSON-only re-ask, review's second angle attempt): the previous row is
  forgotten and a fresh session starts. Only a definite 404 from the server replaces a row. Rows die
  with the job (`finish`, boot `interrupted`/`cancelled` — which also interrupts them —, prune of
  orphans). Keys: review `angle:<name>` and `synthesis`; check and overview jobs one each. A
  `ref`-mode review keeps its throwaway worktree on detach and the re-run reopens it.

`recover()` requeues a `detached_at` row regardless of `attempts` and gives the attempt back — a
detach is not a failure, and the requeue-once budget is for crashes (`docs/deployment.md` § OpenCode
sessions are detached, not drained). A detached session whose job is NOT resumed (`recover` →
`interrupted`/`cancelled`, or a fresh re-run) is interrupted on boot so it cannot keep editing an
orphaned worktree. Known limit: a session re-attached in "cut off" state is resumed with the prompt of
the FIRST call of the re-run, which for a retried angle is the original angle prompt, not the retry's.

**Steer (Wave 4, shipped).** `POST /api/jobs/:id/steer {text}` (MCP `job_steer`, CLI `agw steer
<jobId> <text…|--file F|->`, `server/lib/steer.ts`) posts `delivery: "steer"` into the running
dispatch's session after checking it is `running`, a `dispatch`, carries an OpenCode session id
(`ses_…`) and the session is in `session/active`. 400 empty/oversized (20 000 chars), 404 unknown,
409 nothing live to steer, 502 server unreachable. The text is framed as new facts from the caller
and logged as `job.steer` (the measurable source for steers per episode). Warden steers when a
duplicate occurrence is attached to an item whose episode is still running
(`loop/triaging.py` `steer_live_episode`); a finished episode still goes through a revision.

**Not changing:** the dispatch handler's invariants (`docs/dispatch-security.md`), the repo
lease, `assertInPlaceOpencodeConfigAllowed`, the IU endpoint preflight.

## Version pin and upgrade gate

The 2026-10-11 `brew upgrade` changed behaviour under a running agw and broke every dispatch
(warden JOURNAL). So:

- agw's server runs an **npm install of `@opencode/cli`** at the pinned version, under
  `~/.local/share/agent-gateway/opencode-bin/<version>/` (`npm i @opencode/cli@<version>`).
  The wrapper prefers the npm build matching `OPENCODE_PINNED_VERSION` and falls back to PATH.
- **One version on the whole machine (Wave 10, 2026-10-15).** Homebrew's `opencode` is uninstalled;
  `scripts/opencode` (linked as `~/.local/bin/opencode` by `make install-cli`) execs
  `opencode-bin/current/…/opencode`, a link `install-opencode-bin.sh` keeps on the pinned build.
  Interactive `oc`, `rd wave|work|fan --kind opencode`, `opencode-safe` and the per-user shared
  service (`opencode service restart` picks the new binary) therefore all run the pin. After a pin
  bump re-run `make install-cli install-opencode-agent`. Verified 2026-10-15: `oc run` replied on
  2.0.29 and `rd work <repo> --kind opencode` started, took a prompt and answered (the first start
  on a new version shows a one-time release-notes dialog that swallows the initial prompt —
  dismiss it with Enter). Never `brew install opencode`: it would sit earlier on PATH than nothing,
  but unpinned.
- The pin lives in `OPENCODE_PINNED_VERSION` (`server/mcp/opencode-server.ts`). The install
  directory is mini-local state; `make install-opencode-agent` runs the idempotent
  `scripts/install-opencode-bin.sh` first, so a bumped pin or a reprovisioned machine provisions itself.
- An upgrade is a deliberate act, gated on the probes:
  ```bash
  agw jobs --running                      # step 0: nothing running — a restart kills attached episodes
  D=~/.local/share/agent-gateway/opencode-bin/<new>; mkdir -p $D && (cd $D && npm init -y && npm i @opencode/cli@<new>)
  OPENCODE_BIN=$D/node_modules/@opencode/cli-darwin-arm64/bin/opencode bun scripts/opencode-v2-probe.ts
  # green → bump OPENCODE_PINNED_VERSION, make install-opencode-agent, then
  #         env -u CLAUDECODE bun scripts/opencode-live-probe.ts, make deploy
  # red   → leave the pin; the old install directory keeps serving
  ```
- **2.0.25 → 2.0.29 (2026-10-15).** Probe 55/55 against 2.0.29; one 2.0.25 quirk went away
  (config-defined providers are now listed by `/api/provider|/api/model`, recorded as the fact
  `providers.configDefinedListed`). Reason: the P0 request-timeout failures, and the changelog's
  "faster, safer session snapshots" (the server snapshots each worktree with its own git repo).
- Wave 2 (shipped): the running-server version is in `/api/jobs/health` (`opencodeServer`) and
  `make verify`, the wrapper refuses to start a binary that is not the pinned one, and
  episodes refuse to start against a server whose version differs from it.
- `scripts/opencode-live-probe.ts` probes the SHARED-server path through the production client and
  drive loop (cents of IU tokens; needs the LaunchAgent running): run it after the v2 probe on any
  upgrade and after a change to `opencode-runner.ts` / `opencode-client.ts` /
  `opencode-server.ts`: `env -u CLAUDECODE bun scripts/opencode-live-probe.ts`. Each check has a
  control — `agw-readonly` refuses `touch`/redirect/`curl -o`/file-write tools while `git
  status`/`cat`/`rg` run; an `agw-implement` write lands; the shell runs in `location.directory`;
  session env reaches the shell and the server's credentials are EMPTY there; usage is present per
  turn and the rollup is not below the message sum; `terminateSessionsForJob` interrupts a running
  session (`late.txt` never appears, while an abandoned control session DOES write it); three
  concurrent sessions complete with no lock error. (The retired `--standalone` probe is in git
  history.)

## Credentials of the shared service (interactive `oc`, `rd wave --kind opencode`)

Separate from agw's own server. v2 attaches `oc` and `opencode run` to a shared per-user
service started without the pane's environment, so the `{env:IU_*}` placeholders resolved empty:
`Route.model(openai-compatible-chat) requires an endpoint baseURL`. Reproduced on 2026-10-14
(service pid up three days, no `IU_KEY` in its env) and fixed in dotfiles
(`scripts/opencode-service-env.sh`, called by `_oc_env`): the values go into the service's own
`0600` `service.json` `env` map by environment only, and the service restarts when they change.
Verified with a real reply (`PONG`) through the shared service from an `_oc_env` pane. See
dotfiles `docs/opencode.md`.

## End-to-end proof (Wave 8, 2026-10-15, warden item 1565)

A real item through the whole platform: `warden run warden` (brief: bounded 90-day prune of
`decision_shadow`, an open item from Wave 6).

| Stage | Evidence |
|-|-|
| intake + decision shadow | event 1565, triaged to warden; a `decision_shadow` row is written by the shadow lane |
| investigate | dispatch `46802313-9d86-4583-868e-07b65487123b` → `next: implement` |
| implement #1 | `95d2b744-05fa-434a-91b1-bb3c4248cb43` refused to delete data (`[data_loss]` needs_decision): my brief tagged a retention delete the worker read as an owner question. `warden reinvestigate 1565 --why` carried the decision, no new gate |
| implement #2 (OpenCode session `ses_ec0f3f21cffeWaiiEe3mBTb35d`) | dispatch `ea5108a5-375d-46bb-b339-aa33784fe47c`; `agw steer` mid-run, logged `job.steer` (120 chars); the steer text (single transaction, constant name `SETTLED_RETENTION_DAYS`) shows in the result |
| review → merge train | PR jkrumm/warden#42, **5 revision rounds**, each review a new finding |
| landing | by hand: `make check` green, master ff to `cff7bb9`, `make deploy` → `warden-api healthy`, `/health` schema 22/22 |

Per-revision findings (commit headline → in the scope of the brief?):

1. `scope settle commits to shadow rows` → yes (transaction concern, the steer's topic).
2. `don't commit the shared connection in retention prune` → yes (a real correctness defect).
3. `bound retention prune with a row cap` → no, a hardening the brief did not ask for.
4. `prune settled rows one batch per settle call` → no, drifted from the cap in round 3.
5. (round 5 in flight when the item was landed by hand) → not read; the PR was green and correct.

Rounds 3–5 are review drift: every round raises a *new* finding, so warden's `revisions_left`
(`work.py`, counts only STALLED rounds) never reaches its cap. Same pattern as warden JOURNAL
1478/1480/1481; filed as an improve-loop friction and Wave 9 input.

Platform checks seen on the way: `job.steer` reached a running OpenCode episode; the
`opencodeServer` health block stayed `ok` at pinned 2.0.29; no `ETIMEDOUT` in the ~35 min of
write-tier episodes (the Wave 7 P0 caveat: no recurrence).

## Open items

- Done in Wave 2 as agent rules (`READ_ONLY_SHELL_RULES`); still to run through the probe's
  `permission-order` shape against every entry, not just `git status*`.
- `database is locked` retry removed; the 3-session probe and the Wave 3 gate jobs saw no lock.
  Restore the retry (`git log -S isDbLockedFailure`) only if locks appear.
- Decide whether to move to 2.0.29 (changelog exists from 2.0.26) behind the gate above.
- Title generation is off by construction: a session created WITH a `title` has a settled rollup
  equal to its message sum (delta 0, measured 2026-10-14), without one it runs ~0.00009 USD above
  (the background title call). The runner always sets one.
