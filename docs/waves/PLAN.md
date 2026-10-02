# sideclaw — the single worker engine

**Goal:** sideclaw matches `~/SourceRoot/dotfiles/docs/agent-platform.md` §Sideclaw:
a model registry, a single-shot `triage` job, safe dispatch git flow, review
angles off Max where measured equal, and no model id outside `GET /api/routing`.

**Gate:** `bun run typecheck && bun run lint && bun test` green (`make check` once W3 adds it), plus `/review` on each wave's diff.

**Spec:** `~/SourceRoot/dotfiles/docs/agent-platform.md` — read it first. It wins over older docs here.

**Deploy is the orchestrator's.** Never run `make reload` / `install-agent` from a wave. A wave whose next step is deploy stops and says so in **Left behind**.

**Consumers:** warden (`warden/scripts/clients/sideclaw.py`) calls `POST /api/jobs`. Keep every existing job contract backward compatible; new fields are additive.

## Wave 1 — registry, triage job, honest IU errors            <!-- status: done -->
- [x] `server/lib/models.ts`: one registry (`id`, `wire: anthropic|chat|responses`, `harnesses`, `limit {context, output, minOutput}`, `rate {in, out, cacheRead, source, date}`, `effort`, `jsonObject`, `verified`). Seed it from `routing.ts` and `~/SourceRoot/dotfiles/config/opencode/opencode.json`; mark only ids with probe evidence as verified (deepseek-v4.1-flash, DeepSeek-V4-Flash, claude-sonnet-5, gpt-5.6-terra …). Routing validates every route against it.
- [x] OpenCode runner accepts any registry id whose `harnesses` include `opencode` (drop the single-model throw at `opencode-runner.ts:~771` and the routing.ts cross-check). `buildOpencodeConfig` emits two providers: `iu-chat` (`@ai-sdk/openai-compatible`) and `iu-responses` (`@ai-sdk/openai`, same base URL) — GPT ids go over Responses only. Probe gpt-6.1-sol over Responses once with a trivial tool call; record the result in the registry (`verified` date or leave unverified).
- [x] New job `triage`: single-shot via `textComplete` on the `iu-openai` transport, deepseek-v4.1-flash, `response_format: json_object`, `max_completion_tokens ≥ 16000`, zod-validated, one retry. Input `{ prompt, schema }` (caller supplies the schema); exposed on `POST /api/jobs` and as an MCP tool. Move the review **router** onto the same single-shot path.
- [x] IU error envelopes: a non-zero exit with an `is_error` envelope reports the real cause (e.g. `IU 503: …`), not "exited with code 1 after a success result envelope" (`classifyExitFailure`). An IU 5xx after first output falls back to the route's fallback backend once.
- [x] Dispatch verdict schema (`jobs/handlers/dispatch.ts`): add `rootCause` (≤80 chars, a stable kebab key) and `decisionQuestion` (≤200, only when `nextAction=human`); cap `verdict` ≤600 and `recommendation` ≤400; `summary` stays ≤200. Update `server/skills/dispatch/_common.md` to demand terse output.
**Left behind:** (4 commits d6f507b..HEAD, all uncommitted-to-deploy — **server not reloaded**; the running build still has the old `classifyExitFailure`, so `check`/`review` jobs can still die with "exited with code 1 after a success result envelope" until the orchestrator runs `make reload`; the MCP process also needs `/mcp` reconnect to see the new `triage` tool.)
- Registry `server/lib/models.ts`; unverified/unknown ids refused in routing (env overrides) and at `POST /api/jobs` for **any** tool with a string `model` param (400 `<tool> refused: model X is not a verified registry model`). Warden's escalation model (DeepSeek-V4-Pro) is unverified → refused until probed. gpt-6.1-sol verified 2026-10-02 over Responses (tool call); deepseek-v4.1-flash `json_object` probed 2026-10-02. Unprobed: `@ai-sdk/openai` Responses inside real `opencode run` (no episode run).
- `triage` job (`POST /api/jobs` tool `triage`, params `{prompt, schema}` JSON Schema, MCP tool + `sideclaw triage` CLI); review router now single-shot (not cancellable mid-call). Triage caller prompt is not fenced (it is the task itself).
- 5xx-after-output fallback is read-only/`retryAfterOutput` sessions only — write tiers (implement) excluded (half-applied worktree); dispatch boot-resume + forced fallback passes a resume id (pre-existing, makes it useless there).
- Dispatch verdict: `rootCause`/`decisionQuestion` optional (compat with warden's schema-version 3 pin; no version bump); human-without-question only logs a warning; `DISPATCH_OUTPUT` keeps loose caps, worker-side caps are tight and normalized leniently.
- `bun run typecheck` checks nothing (`tsconfig.json` has `files: []`); real check is `tsc -p tsconfig.server.json --allowImportingTsExtensions` — ~85 pre-existing errors (e.g. `DispatchTier` re-export, `executor.ts:44`). Fix in W3 with `make check`.
- Open review items not done: `buildRoutingTable` override-validation duplication + stale "accepted" entry when model+harness overrides conflict (routing.ts ~547); `getModel(...) as ModelEntry` repeated; opencode default effort hardcoded `"high"`; fallow clones between opencode-runner/session-runner and unused exports; test gaps (triage over-limit inputs, `dispatch.human_without_question` e2e, `addUsage` null cost).
- Intermediate commits d6f507b/062b646/3ebe193 may not typecheck alone (registry↔routing coupling); HEAD is green (1033 tests, lint 0 errors, oxfmt clean).

## Wave 2 — dispatch git safety            <!-- status: active -->
- [x] Read tiers fetch `origin/<default>` and cut from it, not the live checkout HEAD (landed 12fa41b).
- [ ] `revisionOf: <branch>` parameter on implement: the handler (which has credentials) fetches the prior branch and cuts the worktree from it; the worker never fetches. Same PR is updated (push to the same `dispatch/*` branch with `--force-with-lease`), no new PR per revision.
- [ ] Before push: fetch, rebase onto the latest default branch, re-run the repo checks; a conflict fails the job with `conflict` (caller re-dispatches) — never hand-resolved by the worker.
- [ ] New job `update_pr {repo, pr}`: rebase a `dispatch/*` PR onto the latest base, re-run checks, force-with-lease push; returns the new head SHA + check result. This is warden's merge-train primitive.
- [ ] Per-repo lease for implement episodes across all callers (MCP, CLI, warden), not only in-place ones.
**Left behind:**

## Wave 3 — review off Max, repo contract, one source for model ids            <!-- status: pending -->
- [ ] Per-angle route keys (`review_angle_<name>`, default = current). A/B senior-dev, typescript, frontend, qa on OpenCode deepseek-v4.1-flash `high` against Sonnet over ≥5 recent real PR diffs; adopt an angle only where findings are equal or better; record the comparison in `docs/routing-and-quota.md`. Synthesis, security and architect stay Sonnet.
- [ ] Repo contract (spec §Repo contract): Make targets `check`, `deploy` (= the current reload/install path, with health check and rollback to the previous commit on failure), `verify` (`/api/health` + `/api/jobs/health` no degraded routes), `logs`; AGENTS.md sections `## Validate`, `## Deploy`, `## Verify & Monitor`, `## Gotchas`.
- [ ] Remove every model id from prose (AGENTS.md, README, `server/skills/review/README.md`, `docs/agent-overview-internals.md`, `dispatch.ts` param descriptions, `.env.example`) → "see `GET /api/routing`". Move the dated history comments out of `routing.ts` into `docs/routing-and-quota.md`.
- [ ] Fix `warden-board.ts` schema (allow `repo: null`) so the 18k `warden.board_unavailable` warnings stop.
**Left behind:**
