# OpenCode v2 server mode — measured facts, design, upgrade gate

Spec order for this migration: `docs/waves/PLAN.md` > this file > dotfiles
`docs/agent-platform.md` > older docs. Everything under **Measured** was observed on
**opencode 2.0.25** (Homebrew) with `scripts/opencode-v2-probe.ts` on 2026-10-14; the probe is
the executable form of this page and the upgrade gate (below).

**Status: Wave 2 shipped (2026-10-14).** Episodes no longer spawn `opencode run --standalone`;
they run `opencode run --server <url> --agent agw-readonly|agw-implement` against one shared
server under its own LaunchAgent (`server/mcp/opencode-server.ts`,
`scripts/agent-gateway-opencode-start.sh`, `docs/deployment.md`). The NDJSON stream parser is
unchanged. Waves 3–4 (typed client, per-session environment, usage from messages, interrupt,
re-attach) are still ahead.

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
| Config via env | `OPENCODE_CONFIG_CONTENT` (the v1-shaped `buildOpencodeConfig` output) is normalized to v2 (`providers`, `permissions`, `package: aisdk:…`) and works unchanged. Config-defined providers do **not** appear in `GET /api/provider` or `/api/model`; sessions use them anyway (`model:{providerID:"iu-chat",id}`) |

## Measured in Wave 2 (`run --server`, 2.0.25, 2026-10-14)

| Question | Result |
|-|-|
| CLI surface | `opencode run --server URL` takes `--agent`, `-m provider/model#variant`, `--session`, `--format json`, `--file`, `--title`, `--auto`. **No permission, env or config flag** |
| Working directory | Honoured from the **client** process's cwd/`PWD` (the shell ran in the client's cwd), so `buildOpencodeEnv` still pins `PWD` |
| Environment | The shell tool's env is the **server process's env**. The client's env (formerly `extraEnv`) does **not** reach it. Per-run env is therefore impossible on a shared server; `runOpencodeAttempt` throws on any `extraEnv` key the server does not carry |
| Permissions | A config `agents.<name>.permissions` (v2 rule array) plus `--agent <name>` enforces them: with `shell` denied, shell was unavailable. Agent rules are appended after the built-in base policy (allow all; ask on `external_directory` and `.env` reads), so each `agw-*` agent opens with a catch-all rule |
| Server config | `OPENCODE_CONFIG_CONTENT` on the server process (overrides a repo `opencode.json`). Auth: HTTP Basic, `OPENCODE_SERVER_PASSWORD` read by both server and client. `GET /api/info` carries `{version, pid, urls, paths}` and needs no auth (the status probe sends it anyway) |

v2 action names (https://opencode.ai/v2/docs/permissions): `shell` (v1 `bash`), `subagent` (v1
`task`), `read`, `edit`, `glob`, `grep`, `skill`, `question`, `webfetch`, `websearch`,
`external_directory`, `execute`. `list`, `lsp`, `todowrite` and `doom_loop` are not v2 actions
(an unnamed action falls to the catch-all). A **subagent runs under its own permissions**, not
its parent's, so `agw-readonly` denies `subagent` — v1's `task: allow` has no equivalent hole.
`agw-implement` allows it (its own base policy would `ask` on `external_directory` — watch for a
stalled episode).

**Research validation is unavailable on OpenCode review angles until Wave 3.** The server's env
is fixed at start and inherited by **every** worker shell on it, so a credential in it is readable
by any episode. The research-gateway credentials (`RESEARCH_GATEWAY_URL`/`_TOKEN`) are therefore
**not** put there: `runOpencodeAttempt` drops those two `extraEnv` keys with one `warn`
(`session.opencode_extra_env_dropped`, keys only) and the angle runs without them — the curl
recipe in the review prompt has nothing to authenticate with. Wave 3's
`PUT /api/session/{id}/environment` delivers them per session and retires this limitation. Any
OTHER `extraEnv` key the server does not carry still throws. Git credentials stay denied
(`GIT_DENY_CREDENTIALS_ENV` is carried by the server for every episode, including read tiers).

**Killing the client does not stop the session (measured 2.0.25).** SIGTERM to `opencode run
--server` leaves the server-side session `running`, and its tools keep executing (a file was
written 40 s after the kill). `runOpencodeProcessLifecycle` therefore calls
`interruptOpencodeSession` (`POST /api/session/{id}/interrupt`, best-effort, `{interrupted:false}`
on an idle session) once the client process is gone, on every exit path, and logs
`session.opencode_interrupt`. `getOpencodeServerStatus` also requires an authenticated
`GET /api/session/active` = 200, because `GET /api/info` is public and cannot prove the password.

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

**Per-run config moves onto the session (Wave 3).** Model → `model:{providerID,id,variant}`; the
permission profile → `permissions` rules (catch-all deny first, specific allows after, per the
last-match rule — in Wave 2 this is the `agw-*` agent selected with `--agent`); `PWD`/worktree →
`location.directory`; per-job env (`GIT_DENY_CREDENTIALS_ENV`, research credentials) → `PUT
/api/session/{id}/environment`, which retires the research-validation limitation above.

**Usage and liveness (Wave 3).** Usage is read from the assistant messages (paginated), the
settled rollup is the spend total. The idle watchdog keys off the newest message/tool-state
change (`GET …/message?limit=1` or `session/active`), with SSE only as a hint. Cancel is
`interrupt`.

**Durability (Wave 4).** `recover()` lists `running` dispatch jobs, checks `session/active`; a
session that is not active but has no `idle` message is re-attached with `prompt {resume:true}`.
A server restart (crash, SIGTERM, upgrade) therefore costs at most the in-flight tool call.

**Not changing:** the dispatch handler's invariants (`docs/dispatch-security.md`), the repo
lease, `assertInPlaceOpencodeConfigAllowed`, the IU endpoint preflight.

## Version pin and upgrade gate

The 2026-10-11 `brew upgrade` changed behaviour under a running agw and broke every dispatch
(warden JOURNAL). So:

- `opencode` is **pinned in Homebrew** (`brew pin opencode`, 2026-10-14) at 2.0.25.
- The pin is mini-local Homebrew state (`brew list --pinned`); no tracked Brewfile captures it, so
  a reprovisioned machine installs unpinned until `brew pin opencode` is run again.
- An upgrade is a deliberate act, gated on the probe:
  ```bash
  agw jobs --running                      # step 0: nothing running — an upgrade under a live episode is the 2026-10-11 incident
  brew unpin opencode && brew upgrade opencode
  bun scripts/opencode-v2-probe.ts        # all sections; a few cents of IU tokens
  # then bump OPENCODE_PINNED_VERSION (server/mcp/opencode-server.ts), make install-opencode-agent
  # green → keep, update the version noted in this file, brew pin opencode
  # red   → brew uninstall opencode && brew install opencode@<old> (or the cached bottle), pin
  ```
- Wave 2 (shipped): the running-server version is in `/api/jobs/health` (`opencodeServer`) and
  `make verify`, the wrapper refuses to start a binary that is not the pinned one, and
  episodes refuse to start against a server whose version differs from it.
- `scripts/opencode-live-probe.ts` probes the SHARED-server path with the real binary (cents of
  IU tokens; needs the LaunchAgent running): run it after the v2 probe on any upgrade and after a
  change to `opencode-runner.ts` / `opencode-server.ts`:
  `env -u CLAUDECODE bun scripts/opencode-live-probe.ts`. Each check has a control — `agw-readonly`
  refuses `touch`/redirect/`curl -o`/file-write tools while `git status`/`cat`/`rg` run; an
  `agw-implement` write lands and sees `GIT_CONFIG_GLOBAL=/dev/null`; the shell runs in the
  client's cwd; a hostile client env does not loosen `agw-readonly`; a client kill leaves
  `late.txt` coming (control) but `interruptOpencodeSession` stops it. (The retired
  `--standalone` probe is in git history.)

## Credentials of the shared service (interactive `oc`, `rd wave --kind opencode`)

Separate from agw's own server. v2 attaches `oc` and `opencode run` to a shared per-user
service started without the pane's environment, so the `{env:IU_*}` placeholders resolved empty:
`Route.model(openai-compatible-chat) requires an endpoint baseURL`. Reproduced on 2026-10-14
(service pid up three days, no `IU_KEY` in its env) and fixed in dotfiles
(`scripts/opencode-service-env.sh`, called by `_oc_env`): the values go into the service's own
`0600` `service.json` `env` map by environment only, and the service restarts when they change.
Verified with a real reply (`PONG`) through the shared service from an `_oc_env` pane. See
dotfiles `docs/opencode.md`.

## Open items

- Done in Wave 2 as agent rules (`READ_ONLY_SHELL_RULES`); still to run through the probe's
  `permission-order` shape against every entry, not just `git status*`.
- Not yet measured under `--server`: whether SIGTERM to the `opencode run` client stops the
  server-side session (Wave 3's `interrupt` is the reliable cancel), and whether the final
  turn's `step_finish` is still dropped (`usageIncomplete`).
- `database is locked` retry removed (single spawn per attempt); re-measure with concurrent live
  jobs and restore the retry (`git log -S isDbLockedFailure`) only if locks appear.
- Decide whether to move to 2.0.29 (changelog exists from 2.0.26) behind the gate above.
- Measure the title-generation call: whether a session-level setting turns it off (it is cost
  and a `session.renamed` event nobody needs).
