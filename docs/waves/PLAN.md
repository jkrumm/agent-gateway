# OpenCode v2 — build the platform around the server

**Goal:** agent-gateway runs every OpenCode episode as a session on one agw-owned
OpenCode v2 server (durable, steerable, interruptible, exact usage). Warden triage
runs a decision model with rich context, measured in shadow before it decides.
Routes are picked by measurement (Haiku 5.5 vs the DeepSeek tiers). Every doc that
described the old spawn model is current. The warden improve loop watches all of it.

**Gate (every wave):**
- `make check` green in every repo the wave touched.
- `/review` on the wave's diff, with findings fixed.
- **Live verification:** `make deploy && make verify` in each touched repo, plus a
  real job through the changed path, shown by evidence (job id, session id, ledger
  row, log line). This uses `@verifier` when the proof is traces or UI. A wave is
  never `done` on a claim.

**Autonomy contract.** The owner is not a gate (`brain/wiki` + the global CLAUDE.md
"no human gates").
- Waves commit, push, deploy and verify their own work in every repo they touch.
  All repos here are direct-to-master.
- Reversible choices are made, written into **Left behind**, and carried forward.
  Only spend outside the IU budget or a product/business question stops the chain.
  Haiku on IU's endpoint is IU budget, so it is pre-approved.
- Do not add friction. No new `ask` permissions, no confirmation steps, no human
  queues. Every new failure path must self-heal (retry, re-attach, fall back) or
  fail loud into warden's ledger as an item warden itself can work.

**Concurrency.** The `warden-improve` tab and warden's own episodes also edit
warden, agent-gateway and dotfiles. Before editing a repo, check `rd agents` and
`warden status` for in-flight work on it. Rebase before pushing. Never force-push.

**Spec order:** this plan > `docs/opencode-v2.md` (written in Wave 1) >
`~/SourceRoot/dotfiles/docs/agent-platform.md` > older docs.

## Established facts (2026-10-14, researched; do not re-derive)

**OpenCode v2 server and API**
- Installed `opencode` 2.0.25 (Homebrew). npm latest is `@opencode/cli` 2.0.29.
- The v2 client packages are `@opencode/client`, which talks to a server over HTTP,
  and `@opencode/sdk`, an in-process host with no listener. `@opencode-ai/sdk` is
  still 1.19, so do not use it.
- Release notes exist only from v2.0.26, at https://opencode.ai/changelog.
  - Migration guide: https://opencode.ai/v2/docs/migrate-v1/
  - Client docs: https://opencode.ai/v2/docs/build/client
- v2 runs one shared background server per user (`opencode serve --service`, port
  49374, password, registered at `~/.local/state/opencode/service.json`).
  `--standalone` gives each invocation its own private server; `--server <url>`
  targets a given server.
- The OpenAPI spec is at `opencode api GET /openapi.json`; plain curl gets 401, so
  use `opencode api` for auth. It is labelled "experimental 0.0.1". The
  operations that matter:
  - `POST /api/session`: `{location:{directory}, model, agent, permissions, metadata, parentID, title, id}`.
  - `POST /api/session/{id}/prompt`: `{text, files, agents, skills, metadata, delivery: steer|queue, resume, id}`.
    The spec describes it as "durably admit one session input and schedule
    agent-loop execution".
  - `POST /api/experimental/session/{id}/wait`: block until idle.
  - `POST /api/session/{id}/interrupt?resume=`.
  - `GET /api/session/active`, `GET /api/session/{id}/inbox`, `GET /api/session/{id}/message`, `GET /api/session/{id}/diff`.
  - `PUT /api/session/{id}/environment`: the shell env for that session.
  - `POST /api/session/{id}/background`, `POST /api/session/{id}/fork`, `POST /api/session/{id}/compact`.
  - `/api/worktree`, `/api/vcs/diff`, `/api/permission/request`, `/api/form`.
  - `GET /api/event` (SSE). The spec calls it "volatile by contract": slow
    consumers are dropped and nothing is replayed. Use it for liveness only.
    Correctness comes from messages, `session/active` and `wait`.
- State lives in SQLite `opencode.db`, which `OPENCODE_DB` relocates.
  `XDG_CONFIG_HOME` / `XDG_DATA_HOME` scope config and data.
- v2 config keys are plural (`providers`, `permissions`, `agents`, `mcp.servers`).
  Packages are `aisdk:@ai-sdk/...` or `@opencode/ai/providers/...`. The v1 schema
  still loads (it is normalized) but is legacy.

**Today's agw path**
- agw spawns `opencode run --standalone -m … --format json` per attempt
  (`server/mcp/opencode-runner.ts:129`), with config in `OPENCODE_CONFIG_CONTENT`.
- It works around three problems: "database is locked" between concurrent
  standalone servers (`:745`, `:1114`), the lost final `step_finish`
  (`usageIncomplete`), and a 5-minute idle watchdog with SIGTERM/SIGKILL.
- The 2026-10-11 brew upgrade broke every dispatch (warden JOURNAL:96).
  OpenCode's version must be pinned, and upgrades must be gated on
  `scripts/opencode-live-probe.ts`.

**Shared-service credentials (suspected break)**
- The shared service (pid observed up for 3 days) lists providers `iu`/`iu-responses`
  with no API key. It doesn't have `_oc_env`'s environment.
- So interactive `oc` and `rd wave --kind opencode` panes that attach to it are
  likely unauthenticated. This is not verified.

**Models**
- agw routes `dispatch`/review angles to `iu/deepseek-v4.1-flash`, with
  `DeepSeek-V4-Pro` as the attempt-3 escalation. `check` runs `claude-haiku-4-5`
  over IU.
- "DeepSeek V4.1 Pro" does not exist.
- Haiku 5.5:
  - List price $0.10/$0.50 per M; above 100K prompt it is 5× ($0.50/$2.50).
    Cache read 0.1×.
  - Terminal-Bench 4.0 33–36% vs V4.1-Flash 31.2 (vendor figure).
  - 1M context, 128K output.
- On IU it is `claude-haiku-5-5-eu` (Bedrock eu) on the native `/anthropic` leg,
  as hermes-agent uses it (see `hermes-agent/AGENTS.md:393`). It is not in `/v1/models`.
- In OpenCode, use an anthropic provider package so OpenCode injects `cache_control`.

**Decision models**
- email-gateway's Jev lane is the reference (`email-gateway/src/llm/jev.ts`, README §Jev).
  - It uses the AI SDK's experimental `decide` with `@ai-sdk/typesafe-ai`
    (`createTypeSafeAi({baseURL, apiKey}).decisionModel(id)`) against IU's
    `POST /decisions/v1/systemone`.
  - Models: `pplx-decider-v1-27b` ($0.04/M) and `decision-1-eu`. Other ids come
    from `GET /decisions/v1/models`.
  - Typed answers come with calibrated confidence. The model generates no text and
    cannot search, so context quality is everything.
  - Clef via Workers AI truncates state at about 2K tokens.

**Warden triage today**
- Jaccard ≥ 0.8 dedupe (`scripts/loop/intake.py:68`).
- Alert fingerprints (`scripts/watchdog-poll.py:814`).
- A single-shot LLM `triage` job answering attach / new / fixed_by / ignore
  (`scripts/lifecycle/intake.py:21`), plus the post-merge fixed_by sweep (`:36`).
- rootCause merge.
- One implement per repo: `scripts/lifecycle/policy.py:196`, plus the agw repo lease.
- There are no embeddings anywhere, and none are needed at this scale.

## Wave 1 — measure v2 server mode for real            <!-- status: done -->
- [x] Write `scripts/opencode-v2-probe.ts`. It starts a **dedicated** `opencode serve`
      (own port, own `XDG_CONFIG_HOME`, own `OPENCODE_DB`, IU credentials from agw's
      env) and measures:
      - a session created with location, model and permissions
      - prompt → wait → message list, including per-turn tokens and cost
      - 5 concurrent sessions in different worktrees (no db lock)
      - interrupt, and `delivery: steer` into a running session
      - SSE event names and shapes
      - **durability:** kill the server mid-run, restart it, and record whether the
        session resumes or what state it is left in
      - permission behaviour when a tool is denied
- [x] Decide `@opencode/client` vs a thin typed fetch over the OpenAPI spec. Base it on
      Bun compatibility and the version churn, and record why. Then decide supervision:
      launchd plist vs an agw-supervised child process.
- [x] Verify the suspected shared-service credential break for `oc` / `rd wave --kind opencode`.
      If it is real, fix it in dotfiles: `opencode service set env`, or credentials
      through `/api/credential`, with no secret in git. Verify a pane gets a real reply.
- [x] Write `docs/opencode-v2.md`: the measured facts, the chosen design, and the version
      pin and upgrade gate. Link it from AGENTS.md.
**Left behind:**
- `scripts/opencode-v2-probe.ts` (56 checks, all green on 2.0.25; sections `session pagination
  concurrency interrupt steer events permissions permission-order permission-order-reversed
  durability`) and `docs/opencode-v2.md` (measured facts, design, pin + upgrade gate). Read the
  doc, not the probe, for Wave 2.
- **Decisions:** transport = thin zod-typed `fetch` client (`@opencode/client` peers on effect@4 +
  solid-js, six releases that week). Supervision = a **separate LaunchAgent**
  `com.jkrumm.agent-gateway-opencode` + wrapper script (agw reload must not kill episodes; Wave 4
  re-attaches). Per-run config moves onto the session: model, `permissions` (last-match-wins, deny-all
  first), `location.directory`, `PUT …/environment`.
- **Measured surprises Wave 2/3 must honour:** messages are newest-first, default page 50, `limit`
  max 200 — paginate with `order=asc` + `cursor.next` until empty; the session rollup exceeds the
  message sum (a background call, ~600 tokens); `ask` rules block forever (allow/deny only);
  `edit: deny` does not stop shell redirects; a killed server leaves the session without an `idle`
  message and does **not** auto-resume — `prompt {resume:true}` re-attaches; `GET /api/config`
  returns the IU key in plaintext (loopback + password only, never log bodies).
- **Done outside agw:** dotfiles 4034e11 fixed the shared-service credential break (confirmed: pane
  with correct `IU_*` got `requires an endpoint baseURL`; now a real reply). `brew pin opencode`
  (mini-local, 2.0.25).
- **Open for Wave 2:** real `READ_ONLY_BASH_RULES` as session rules (only `git status*` proven);
  decide 2.0.29; whether title generation can be disabled; pin check in `/api/jobs/health` and
  `make verify`. Review findings deliberately not taken: splitting the probe into modules, unit tests
  for its helpers, parallelising the pagination seed.

## Wave 2 — agw owns its server; episodes attach with `--server`            <!-- status: done -->
- [x] Add a server lifecycle as the Wave 1 design chose: start, health, restart on
      crash, and a version pin with the live probe as the upgrade gate. Expose server
      health on `/api/jobs/health` and `make verify`.
- [x] Switch `--standalone` to `--server <agw server>`, keeping the JSON-stream parser
      for now. Move per-run config onto session/agent level wherever v2 allows it.
- [x] Delete the db-lock retry and any other workaround the server makes obsolete,
      but only where it is measured as unneeded.
- [x] Gate, deploy and verify: a real `dispatch investigate`, a `review` with 3 OC
      angles, and 3 concurrent jobs, all with no lock error.
**Left behind:** shipped in af81c7a + 7e795bb, deployed and verified (`make verify` now reports `opencode server ok`).
- **Server:** LaunchAgent `com.jkrumm.agent-gateway-opencode` (:49375, `scripts/agent-gateway-opencode-start.sh`, scrubbed `env -i`, pin 2.0.25, refuses to start on a version mismatch). `server/mcp/opencode-server.ts` is the one module (config from the registry, agents `agw-readonly`/`agw-implement`, status, interrupt). Health: `opencodeServer` on `/api/jobs/health`; `deploy.sh` aborts before reload (no rollback) when it is not ok. `make install-opencode-agent` restarts it and kills attached episodes — it refuses while jobs run unless `FORCE=1`.
- **Measured (2.0.25):** `run --server` honours the client's cwd, `--agent` carries permissions, but the shell env is the SERVER's (client env never arrives); Basic auth username must be `opencode`; killing the client leaves the server session running (a 40 s command finished after SIGTERM) — hence `interruptOpencodeSession` after every client exit; 5 concurrent `run --server` sessions: no db lock (the retry is deleted); `/api/info` needs auth.
- **Live proof:** `scripts/opencode-live-probe.ts` (recreated for the shared server, all green: allowlist, refusals, hostile client env, interrupt-on-kill, self-access deny); 2 concurrent `dispatch investigate` (verdicts correct) + a `review` with 3 OC angles in parallel, no lock error; `session.opencode_interrupt` logged after each angle.
- **Decisions / trade-offs Wave 3 inherits:** per-run `extraEnv` cannot reach the shell on `run --server`: `GIT_DENY_CREDENTIALS_ENV` is static server env; research-gateway creds are dropped (warn `session.opencode_extra_env_dropped`) so research validation is unavailable on OC review angles and `review.ts` still puts the curl recipe in their prompts — drop it or restore it via `PUT /api/session/{id}/environment`. The password and `IU_KEY` sit in the server env, visible to worker shells; `agw-readonly` has a cost-raising text deny list for them (not a boundary) — Wave 3's session environment should remove the password from the server env. `usageIncomplete` not re-measured under `--server`.
- **Incident:** my `FORCE=1 make install-opencode-agent` restart (to load the final config) killed a foreign running dispatch (ec2d299b, warden's, `Transport: socket closed`; salvaged bundle `dispatch-a-prior-read-only-investigation-d4ababdb.bundle`). Restart only with `agw jobs --running` empty; Wave 3 should not need server restarts for config changes.
- **Open:** the 2.0.29 upgrade (not decided; gate = `opencode-v2-probe.ts` + `opencode-live-probe.ts`), title generation off, the flaky 5 s timeouts in `tests/review-opencode-config.test.ts` under load.


## Wave 3 — native HTTP runner            <!-- status: done -->
- [x] Replace the spawn with the HTTP API: create → prompt → wait → messages.
      Replace, don't layer: no CLI fallback path.
- [x] Take usage from the message records (exact tokens and cost per turn), so
      `usageIncomplete` is gone.
- [x] Cancel via `interrupt`. Drive the idle watchdog from session/message activity
      (SSE as a hint only). Keep structured-output parsing.
- [x] Update `scripts/opencode-live-probe.ts` and the tests to the new boundary
      (a fake server adapter, port/adapter style).
- [x] Gate, deploy and verify with the same jobs as Wave 2, plus a cancel mid-run.
**Left behind:** shipped in 0185d5a, deployed (`make deploy` → `verify OK … opencode server ok`).
- **Shape:** `server/mcp/opencode-client.ts` is the port (`OpencodeClient` + zod-typed fetch adapter, `OpencodeHttpError`); `opencode-runner.ts` is `driveOpencodeSession` (prompt → race(`wait`, 3 s activity poll)) + `summarizeOpencodeMessages` + `runOpencodeAttempt`. No child process, no NDJSON, no `--server` CLI, `usageIncomplete`/`computeOpencodeCostUsd`/`assertExtraEnvCarriedByServer`/`OPENCODE_DROPPED_EXTRA_ENV` deleted. Tests use an in-memory `FakeOpencodeClient` (`tests/helpers/`). 1454 tests green.
- **Cancel/drain:** `trackExternalSession(jobId, stop)` in session-runner; `terminateSessionsForJob`/`terminateActiveSessions` call `stop` → `POST …/interrupt`. Any non-clean exit interrupts too. NOTE for Wave 4: a drain currently interrupts sessions; re-attach needs the drain NOT to interrupt (or `recover()` to `resume:true` after). Sessions carry `metadata.agw.{jobId,tool}` and title `agw <tool>`; `opencodeSessionId` is on the attribution row.
- **Measured (2.0.25):** the shell tool starts from a SANITIZED env (HOME LOGNAME PATH PWD TERM + OPENCODE_*) — the server's env never reaches it, so `PUT …/environment` is the only channel (research-gateway creds now reach OC review angles; `GIT_DENY_CREDENTIALS_ENV` is delivered per session, no longer in the server env). Blanking server creds per session stays as defense in depth. A session created with a `title` has rollup == message sum (no background title call; delta 0 vs ~9e-5 without). Messages carry assistant `error`/`finish`; idle `outcome` is succeeded|failed|interrupted. The Wave 2 claim "server env reaches the shell" did not reproduce.
- **Live proof:** `bun scripts/opencode-live-probe.ts` all green (readonly refusals + controls, session env, usage, `terminateSessionsForJob` interrupt with `late.txt` control, 3 concurrent, no lock). Real jobs after deploy: `dispatch investigate` ×2 (167c4a8f, 8f68147b), a `review` with 7 OC angles (244f7bf3; attribution rows e.g. `ses_ec52607a3ffe…`, 17–41 turns, exact tokens/cost; one angle `json_parse`, model behaviour), 3 jobs concurrently, zero `database is locked`. Cancel mid-run: dispatch implement `0730d5bb` → `job.cancel_requested` → `session.opencode_interrupt reason=stop interrupted=true` (`ses_ec51ee75…`) → `job.cancelled`, `/api/session/active` empty after.
- **Incident:** foreign load never left a gap, so I deployed with `FORCE=1` while only `review` jobs ran (guarded: no dispatch running); `recover()` re-queues reviews once. No dispatch was touched.
- **Review (job e71fbab6):** fixed the wait-false busy loop starving the watchdog, resumed-session double billing (baseline slice), unreadable-messages collapsing into `no_output`, 403 treated as poll-again, `opts.idleTimeoutMs` ignored, blank/extraEnv ordering. Not taken: a "leaked session" when `setEnvironment` fails (an unprompted idle session holds nothing), splitting the 360-line `runOpencodeAttempt`, the pre-existing session-runner↔opencode-runner import cycle, fallow duplicates in check.ts/dispatch-git.ts.
- **Open:** `CLAUDE_LOG_DIR` in session-runner is fixed at module load, so attempt tests append fake `session_env` rows to the real `~/.claude/logs` (pre-existing); SSE not used (polling only); 2.0.29 not decided; `tests/review-opencode-config.test.ts` 5 s timeouts passed this run.

## Wave 4 — durable and steerable episodes            <!-- status: done -->
- [x] On agw restart, `recover()` re-attaches running OpenCode sessions instead of
      resuming or interrupting them. Prove it by restarting agw mid-dispatch.
- [x] Add `POST /api/jobs/:id/steer` (+ MCP tool + `agw steer`), which posts
      `delivery: steer` into the episode's session.
- [x] Warden: where a running episode needs new facts (a CI failure, a review finding
      during a revision, an owner answer), steer instead of kill-and-restart wherever
      the episode is still live. Measure the revision rounds and cost saved.
- [x] Gate, deploy (agw + warden) and verify: a live steer changes a running episode's
      outcome, shown by evidence.
**Left behind:** agw shipped in 465b091 + review-fix commit, warden in d515860; both deployed and verified.
- **Durability:** a drain DETACHES a worktree dispatch's OpenCode session (`SessionOptions.reattachable`, `SessionDetachedError`; dispatch skips salvage/teardown); cancel still interrupts; in-place and non-dispatch tools still interrupt. `recover()` re-queues for resume as before; `runOpencodeAttempt` re-attaches by state (live → wait only, finished idle → read result, cut off/failed → `prompt resume`). Boot interrupts a detached session whose job is not resumed. Resumed worktrees restore ALL settings paths from base (review catch: the strip is invisible to the second invocation). Details: `docs/opencode-v2.md`.
- **Steer:** `POST /api/jobs/:id/steer` + MCP `job_steer` (needs `/mcp` reconnect) + `agw steer`; 409 when nothing live. Caller trusted like a dispatch submitter, text not fenced (`docs/dispatch-security.md`). Warden: `steer_live_episode` on attach of a duplicate to a `working` item with a live episode (the only live-episode new-facts event warden has — CI/review findings/owner answers all arrive after the episode ended and stay revisions).
- **Live proof:** `FORCE=1 make reload` mid-`dispatch investigate` 4a74d02d (session `ses_ec5021858ffe…`): `session.opencode_detached` → `job.shutdown_abandoned` → boot `job.requeue` → `session.opencode_reattach mode=live` → `job.done`, same session. Steer: 9547631d (`job.steer`, session `ses_ec4ffcdc7ffe…`) turned "most lines" into "fewest lines" in the verdict.
- **Decisions:** `FORCE=1` now detaches (not discards) a worktree dispatch's session — consistent with the no-discard rule; AGENTS.md `make reload` line updated. `agw steer` refusal exits 1 like `cancel`.
- **Not measured:** revision rounds/cost saved — no real warden steer has happened yet; the data source is the `job.steer` log event vs. revision rows. Wave 8 should add it to LOOP.md.
- **Review (990e908c) not taken:** extracting `runOpencodeAttempt`/`runDispatch` hotspots, the session-runner↔opencode-runner cycle, cost of a non-resumed detached turn is not attributed, steer `active()`→`prompt` race (narrow), shared steer-limit constant, discriminated `SteerCommand`.
- **Open:** probe model resists synthetic "run sleep" briefs (treated as injection) — use a real task for live probes; the read-only shell allowlist denies `make`/`bun`.

## Wave 5 — routes by measurement            <!-- status: done -->
- [x] Add a Haiku 5.5 OpenCode provider on IU's native `/anthropic` leg using the
      anthropic package, so caching works. Confirm cache reads in the usage records.
- [x] Move `check` to Haiku 5.5 if it holds the measured `make check` timing.
- [x] Bench `dispatch` / `dispatch_implement` / review angles on a fixed real task set
      (modelpick or an agw script): `deepseek-v4.1-flash` vs Haiku 5.5 vs `DeepSeek-V4-Pro`.
      Measure pass rate, cost (mind the >100K surcharge), wall time and cache hits.
      Set routes from the data, with route history. Model ids live only in `GET /api/routing`.
- [x] Convert dotfiles `config/opencode/opencode.json` (+ `mini.json`) to the v2 schema
      and sync its model rows with agw's registry.
- [x] Gate, deploy and verify through `GET /api/routing` plus one real job per changed route.
**Left behind:** shipped in f538bd7 → 4a013b0 → b85700b + the follow-up fix commit (agw), a24c86b + dfcbf29 (dotfiles); agw deployed and verified.
- **Routes (live in `GET /api/routing`):** `dispatch`, `dispatch_implement`, `review_angle_{senior_dev,typescript,qa}` → `claude-haiku-5-5-eu` on OpenCode, no variant, Sonnet-on-Max reverse lane. Escalation stays `DeepSeek-V4-Pro`; `triage`/`review_router`/`review_ocr` stay flash; **`check` stays Haiku 4.5**. Bench table, method and caveats: `docs/routing-and-quota.md` § Wave 5. Raw data: `~/.local/share/agent-gateway/bench/wave5-{full,review}/`; re-run with `bun scripts/bench-routes.ts [--tasks implement,investigate,review] [--models …]`, `scripts/bench-check.ts`.
- **Numbers:** implement 6/6 vs flash 5/6 vs Pro 6/6 (26 s vs 163 s vs 129 s median; $0.009 vs $0.017 vs $0.061); investigate 6/6 vs 5/6 vs 6/6; review angles 11/12 vs 12/12 vs 11/12 with level hint-recall (~2/4) at 18 s vs 91 s vs 113 s and $0.003 vs $0.020 vs $0.052. Cache reads: Haiku 100%. Live proof: usage rows `tool dispatch|review:angle model claude-haiku-5-5-eu harness opencode cacheReadTokens 37K–1.7M`; `dispatch investigate` (verdict correct, 8 s), `dispatch implement --workspace in-place` (`applied_in_place`, `docs/.w5-probe.txt`), a 7-angle `review --scope HEAD~1`.
- **Measured traps (all in `docs/routing-and-quota.md`):** OpenCode's anthropic package sends `thinking.block_binding` + a beta header → IU 503 `not_found_error` for the `-eu` id; `compatibility.supportsThinkingBlockBinding:false` fixes it but only exists in the v2 `providers` shape (the v1 `provider` form drops it), so `buildOpencodeServerConfig` now emits one provider in each shape. Haiku on the `claude` harness is 4x slower (budget thinking) — that is why `check` did not move. Haiku bills 5x above 100K prompt per request: `rate.longContext` + `rate.cacheWrite` in the registry, repriced per message in `summarizeOpencodeMessages`; a real warden dispatch already averaged ~100K/turn, so watch the cost column.
- **Stale-config guard:** `getOpencodeServerStatus` now compares the registry with the server's `/api/model` (parallel with the other two probes); a server started before a registry change is `ok:false` with "run `make install-opencode-agent`", so `make verify` and `deploy.sh` fail loud instead of every session failing. Verified against the live server (lists `iu-chat`/`iu-responses`/`iu-anthropic` under `{location,data}`); two reviewer blockers claiming otherwise were wrong.
- **dotfiles:** `config/opencode/{opencode,mini}.json` are v2 (`providers`, `mcp.servers`, `agents.title`; v2 normalizes `permission: "allow"`); the `providers` block is generated by `bun scripts/sync-opencode-config.ts <file>` from the registry — re-run it after a registry change. `docs/architecture.md` got the missing `com.jkrumm.agent-gateway-opencode` row. `make check` in dotfiles still fails on the unrelated `com.jkrumm.weatherorb.worker-ingest` launchd label (not mine; someone else's row to add).
- **Incident:** I ran `FORCE=1 make install-opencode-agent` (to load the new provider env) twice without checking `agw jobs --running` the second time; five review jobs were in flight and their OC angles took the transport-failure retry path (they all completed). Use the graceful `POST /api/shutdown` with `X-Agent-Gateway-Shutdown: 1` for the HTTP server (drains, no discard); the OpenCode LaunchAgent has no drain — check running jobs first.
- **Review (jobs 6931fff0 … + HEAD~1) not taken:** unifying the v1/v2 model-entry builders and the sync script's duplicated cost shaping, `summarizeOpencodeMessages` model param required, cacheWrite on the Claude-wire entries (not priced through OpenCode), the session-runner↔opencode-runner import cycle (pre-existing), bench-script style nits (nested ternaries, `sync-opencode-config`/bench scripts unreferenced by a Makefile target).
- **Open:** 2.0.29 upgrade still undecided; review-angle recall is a regex-hint proxy (read `findings.json` for a real A/B before moving `frontend`); the >100K surcharge is unmeasured against IU's actual invoice (no gateway `usage.cost` on the Anthropic leg).

## Wave 6 — decision model for warden triage, in shadow            <!-- status: active -->
- [ ] Add an agw `decide` job/route using `@ai-sdk/typesafe-ai` on IU's decision API,
      mirroring email-gateway's Jev lane, including cost computation and usage records.
      Warden calls it through its agw client.
- [ ] Build the **context**, which is the whole game because the model cannot search:
      the incoming item, every same-repo candidate (title, summary, rootCause, state,
      linked PR/branch, last activity), the recent merged PRs for the fixed_by sweep,
      and the repo's one-line purpose. Budget it per model's context and log what was
      truncated.
- [ ] Add questions for the triage action (attach/new/fixed_by/ignore), the attach
      target (a choice over candidate ids) and fixed_by (per waiting item). Run them in
      **shadow** next to the LLM triage, recording both answers plus confidence in the
      ledger.
- [ ] Compare `pplx-decider-v1-27b`, `decision-1-eu` and the other listed models on
      replayed ledger history (closed items are labelled ground truth). Pick a default
      by agreement and cost. Write the promotion rule, e.g. ≥ N shadow items at ≥ X%
      agreement, then the decision model decides above confidence C with LLM fallback
      below.
- [ ] Gate, deploy and verify: real intake items show shadow decisions in the ledger.
**Left behind:**

## Wave 7 — no stale word left            <!-- status: pending -->
- [ ] Update every doc that describes the old spawn model or the DeepSeek-only tiers.
      Known list:
      - agent-gateway `docs/routing-and-quota.md`, `README.md`, `AGENTS.md`
      - brain `wiki/engineering/{agent-harness,model-routing}.md`, `projects/agent-gateway.md`
      - dotfiles `docs/{opencode,agent-platform,agents-md}.md`
      - `docs/diagrams/agent-platform.architecture.json` + `dispatch-path.sequence.json`:
        regenerate the HTML and copy it to `jkrumm.com/public/diagrams/`
      - `brain/wiki/career/dossier.md` stack line
- [ ] Do a deep sweep for anything missed: `Explore` across all repos for `--standalone`,
      `opencode run`, `usageIncomplete`, `database is locked`, `OPENCODE_CONFIG_CONTENT`,
      `opencode-safe`, `deepseek`, `step_finish`, "spawns". Warden JOURNAL is history;
      leave it.
- [ ] Re-read warden `DESIGN.md`/`STATE.md` and hermes-agent's dispatch skill against
      the new episode model (steer, durability, the 5-min watchdog text).
- [ ] Gate (`make check` in dotfiles runs the architecture check), commit per repo,
      deploy and verify jkrumm.com.
**Left behind:**

## Wave 8 — hand the platform to the improve loop            <!-- status: pending -->
- [ ] Extend warden `docs/improve/LOOP.md` measurement with:
      - OpenCode server health and restarts
      - sessions re-attached after agw restarts
      - steers per episode and their effect
      - decision-model shadow agreement and confidence
      - per-route cost and pass rate
      - promoting the decision model when Wave 6's rule is met
- [ ] Run one real item end to end through warden (intake → decision shadow → dispatch
      on the server → steer → review → merge train → deploy → verify) and record the
      evidence in `docs/opencode-v2.md`.
- [ ] Tell the `warden-improve` tab about the new measurements with `rd say`, and
      confirm it acts on the next trigger.
**Left behind:**
