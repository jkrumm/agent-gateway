# Worker routing — backend selection and fallback

Full rationale behind `server/lib/routing.ts` and `resolveBackend`. AGENTS.md
keeps the per-tool table and the top-level rule; this is the "why" — read on
demand when touching routing or the fallback retry logic.

## Backends

**Owner rule (2026-10-24): `dispatch_implement` and `dispatch_implement_escalation` run on Max only — no code is written on IU tokens.** Both are Sonnet on `max` over `claude -p` with `fallback: null` (`MAX_ONLY_TOOLS` in `routing.ts`): a model override that Max cannot serve, a `iu` backend override and an `opencode` harness override are refused at table-build time, and a per-job `model` that Max cannot serve is refused at submit (`dispatchSubmitRefusal`) and ignored by `withModel`. With no IU fallback, an exhausted Max account pool fails the attempt closed (`resolveAttemptAccount`: no IU spill). Editorial and investigate stay on IU.

**`iu`** injects `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` from
`getIuConfig()` (the IU unified endpoint's native Anthropic transport, metered
per token, serves Claude _and_ gateway ids — a gateway id additionally gets
every `ANTHROPIC_DEFAULT_*_MODEL` pinned to itself, `CLAUDE_CODE_MAX_CONTEXT_TOKENS`
from `GATEWAY_CONTEXT_TOKENS`, `API_TIMEOUT_MS` raised, mirroring dotfiles'
`ca`); **`max`** deletes those vars so the CLI falls through to the inherited
OAuth profile — Claude ids only, a gateway id is refused back to `iu` at
table-build time.

Three routes — `adversary`, `read_image`, `read_drawing` — never reach
`runSession()` at all: they call the IU OpenAI transport directly
(`server/lib/iu-openai.ts`) and consume only `.model`. Their `backend`/
`fallback` fields are informational defaults only (always `iu`, never
overridable). `GET /api/routing` marks them `transport: "iu-openai"` (every
other route is `transport: "session"`), and a `AGENT_GATEWAY_BACKEND_<TOOL>`
override on one of the three is refused rather than silently accepted and
displayed with no effect.

Overrides: `AGENT_GATEWAY_MODEL_<TOOL>=<id>`, `AGENT_GATEWAY_BACKEND_<TOOL>=iu|max`
(`<TOOL>` = route key upper-cased), read once at module load → `make reload`;
`AGENT_GATEWAY_WORKER_FALLBACK=none` pins every tool to its primary. A job's
`model` param (`overview`, `narrative`, `dispatch`) is applied with
`withModel` — a Claude override also becomes the fallback model, a gateway
override forces `iu`. The effective override list (applied + refused) is
logged once at startup by each entrypoint (`logRoutingOverrides` —
`info`, or `warn` if it contains a refusal) so a typo'd `.env` entry is
visible without curling `/api/routing`. The same entrypoints also call
`logStaleQuotaEnvVars`, a `warn` if a real `.env` still sets one of the three
retired quota env vars below (`AGENT_GATEWAY_MAX_QUOTA_CEILING`,
`AGENT_GATEWAY_MAX_WEEKLY_CEILING`, `AGENT_GATEWAY_QUOTA_FILE_MAX_AGE_S`) — they are a
silent no-op otherwise.

Every session writes a `session_env` line to `~/.claude/logs/<date>.jsonl`
with `base_url` (real on `iu`, explicit `null` on `max`), `model` and
`backend`, plus an attribution record to
`~/.local/share/usage-tracker/agent-gateway-sessions.jsonl` carrying the same —
usage-tracker classifies by `base_url` present → `iu`, `null`/missing →
`max`, and bills the run to the model actually used.

## Fallback, both directions — once per session, never twice, purely reactive

`resolveBackend(route)` runs per launch, pure and synchronous: a non-Claude
id → `iu` unconditionally (defense in depth — `buildRoutingTable`/`withModel`
already guarantee this by construction for any route built through the
table, but a hand-built route bypassing it, as the tests do directly, must
still never slip a gateway id onto `max`); every other route just stays on
its configured backend.

This used to also read live Max subscription quota before every `max`
launch and pre-empt onto `iu` above a ceiling (90% five-hour / 95% seven-day,
via the statusline's cached usage file or the live Keychain-backed OAuth API).
**Removed 2026-09-08** — false-positive triggers off a stale/misread quota
reading, and every concurrent worker pre-empting at once under burst, cost
the owner more money and disruption than the quota it saved. Do not re-add a
proactive check here: the reactive fallback below is the actual safeguard and
is unchanged.

**Reactive retries in `runSession`**, both gated on the route's declared
`fallback` and on "no worker output yet" (`turnsRef.current === 0`), both
latched so the fallback attempt itself is never switched again:

- **`max` → `iu`**: an attempt classified as quota/rate-limit exhaustion
  forces the next attempt onto `iu`, same model (`backend.fallback`, reason
  `rate-limited`). Takes precedence over the transient-transport retry. Two
  signals feed the classification, checked in order:
  1. `SessionResult.hadApiRetry` — the runner observed a stream-json
     `system`/`api_retry` event during the attempt, i.e. the CLI itself
     retried after a provider-side 429/529. The truer signal when present,
     but not exhaustive on its own — a hard, definitive quota block the CLI
     never got a chance to retry produces no `api_retry` event at all, so it
     cannot be the only path.
  2. Otherwise, `isQuotaError` regex-matches `SessionResult.classificationText`
     — stderr and the runner's own constructed error text ONLY, **never**
     model-generated stdout. A worker's own output (a diff, an otel trace
     dump, a check report) can legitimately contain the words "429" or
     "quota" with no real exhaustion behind it; matching against it would
     switch a run that would have finished fine on the already-paid `max`
     subscription onto the metered, billed-per-token `iu` lane for nothing.
     `classificationText` is therefore populated only on the branches whose
     text is transport/provider-sourced (stderr, the constructed timeout/
     exit-code/no-envelope messages, `envelope.errors`) and left unset on the
     branches that embed real worker output (an unparseable `result` field, a
     schema-validation failure) — those can never quota-classify. The
     `is_error` branch is a narrow exception, not a third case: when
     `envelope.errors` is absent it falls back to `envelope.result`, but only
     when the session produced zero assistant turns (`classifyErrorEnvelope`)
     — with no turn at all the model never ran, so `result` cannot be its
     text and must be transport/gateway-sourced; at least one turn leaves it
     unset, same as the other worker-output branches. This is the one
     remaining diagnosis a terminal Max quota/usage-limit rejection carries
     when it arrives as `is_error` with no structured `errors` array and no
     observed `api_retry` — without it the reactive fallback cannot see that
     shape of quota exhaustion at all. See `runSessionAttempt` in
     `session-runner.ts` for exactly which branch sets which.
- A `backend: "max"` session that times out is never quota-classified by
  either signal above (its `classificationText` is a fixed string
  `QUOTA_ERROR_RE` never matches, and a hang produces no `api_retry` event).
  That gap is not resolved — a timeout carries no evidence either way — but
  is logged (`session.timeout_unclassified`, warn) so it is visible instead
  of silent.
- **`iu` → `max`**: a transport failure (`isRetryableSessionError`:
  429/502/503/504, connection errors) is first retried once on `iu` — a
  single 503 is the common case and must not spend Max quota — and if that
  fails the same way the next attempt runs on `max`, on `fallback.model` when
  the route fixes one (every OpenCode route → Sonnet on Max, since
  a gateway id cannot run on Max) or the same model (`backend.fallback`, reason
  `iu-unavailable`). Missing IU credentials (`iuConfigError`) and a **timeout
  with zero worker events** skip the same-backend retry and go straight to
  it. No caller currently sets `retryAfterOutput: true` — `check`, `overview`
  and `review`'s router all rely on the idle watchdog in `session-runner.ts`
  (no separate wall-clock cap) rather than re-laning after a timeout that
  already produced turns; see each handler's own comment for why. This is
  what keeps "IU down, Max fine" from being a dead lane.

  **Thinking budget** (`ToolRoute.thinkingTokens`, `server/lib/routing.ts`):
  `--effort`/`reasoning_effort`/`thinking:{type:disabled}` are all ignored by
  the Requesty hop for every gateway id alike, so the only lever that reaches
  one on the `claude` harness is `MAX_THINKING_TOKENS` (the CLI's env var for
  Anthropic's `thinking.budget_tokens`), exported by `buildWorkerEnv` for any
  non-Claude route. The retired `claude -p` CLASSIFY tier (check/overview, Haiku 4.5 over IU;
  GLM retired 2026-09-23) ran at 2048; JUDGE stays on Claude and carries no `thinkingTokens`. `dispatch`/
  `dispatch_implement` carry none either — AGENT/AGENT_IMPLEMENT (this
  `thinkingTokens` mechanism, DeepSeek-V4-Flash/-Pro over the IU native
  Anthropic transport) were retired 2026-09-24 for AGENT_OC/AGENT_OC_IMPLEMENT
  (`harness: "opencode"`; `deepseek-v4.1-flash` then, `claude-haiku-5-5-eu` over the native
  Anthropic leg since Wave 5 — see § Wave 5) — opencode has no `MAX_THINKING_TOKENS` equivalent, only the
  reasoning-effort variant (`provider/model#variant`; `"high"` investigate/author,
  `"max"` implement, same reasoning tier split
  AGENT_IMPLEMENT used to encode). Overridable per tool via
  `AGENT_GATEWAY_THINKING_TOKENS_<TOOL>` (claude-harness routes) or
  `AGENT_GATEWAY_HARNESS_<TOOL>`/`AGENT_GATEWAY_VARIANT_<TOOL>` (any route), same env
  pattern as the model/backend overrides above. Full harness rationale:
  `AGENTS.md`'s Worker routing section.

`SessionResult.backend` and `.model` carry what actually ran;
`overview`/`narrative` job output carries `backend` too. Tests:
`tests/routing.test.ts` (table, tiers, overrides, `withModel`,
`logRoutingOverrides`/`logStaleQuotaEnvVars` against a fake logger),
`tests/backend-select.test.ts` (`isQuotaError`'s regex matrix),
`tests/session-retry.test.ts` (`resolveBackend`'s pure short circuits,
`planNextAttempt`'s retry/fallback/classification decision including the
regression guard that model-output text alone never quota-classifies,
`classifyErrorEnvelope`'s zero-turn carve-out, `unclassifiedOutputFailure`'s
`hadApiRetry` propagation, `backendFallbacksLastHour`/`recordFallback`'s
1-hour window), `tests/jobs-health.test.ts` (`GET /api/jobs/health` carries
`backendFallbacks`).

## Per-angle review routes

The worker angle sessions in `review` resolve their route through
`routeForReviewAngle(angle)` (`server/lib/routing.ts`): `senior-dev`,
`typescript`, `frontend` and `qa` each have their own route key
(`review_angle_senior_dev`, `review_angle_typescript`, `review_angle_frontend`,
`review_angle_qa`); every other angle (architect, backend, security, …) and the
synthesis keep using `review`. `senior-dev`, `typescript` and `qa` default to the
cheap OpenCode route (`ANGLE_OC` in `routing.ts`: `claude-haiku-5-5-eu` on `iu` via
the opencode harness, no variant since Wave 5 (flash `"high"` before), with the `review` route's Sonnet on Max
as the reverse lane). `frontend` and every angle without a key of its own stay
on the `review` route. The env names follow the usual rule (route key
upper-cased): `AGENT_GATEWAY_MODEL_REVIEW_ANGLE_TYPESCRIPT`,
`AGENT_GATEWAY_HARNESS_REVIEW_ANGLE_TYPESCRIPT`, `AGENT_GATEWAY_VARIANT_...`, etc. A model
that only the opencode harness can run needs its `AGENT_GATEWAY_HARNESS_...=opencode`
override alongside, otherwise the model override is refused and the angle stays
on its default. Pinning an `ANGLE_OC` angle back onto the review route takes a
Claude model override plus `AGENT_GATEWAY_BACKEND_...=max` (the harness normalizes
back to `claude` on its own; a bare `AGENT_GATEWAY_HARNESS_...=claude` with the
default opencode-only model is refused). A job's `model` param still applies to
every angle session via `withModel`, on top of whatever the angle's own route
resolved to.

### Review-angle A/B (Wave 4, 2026-10-05)

**Gaps closed (kept for the record).** The four gaps that blocked an OpenCode
review angle were closed 2026-10-05:

1. **Max fallback on an overridden angle.** `buildRoutingTable` gives a `review_angle_*`
   whose model override strands it on `iu` a reverse lane to `max` on the angle's default
   Claude model (Sonnet), run via `claude -p`. The adopted `ANGLE_OC` angles declare that
   fallback directly; the then-`JUDGE` `frontend` angle had it synthesized by
   `effectiveFallback` (removed in Wave 11, when `frontend` moved to `ANGLE_OC` and no
   per-angle route had that shape any more).
2. **Repo agent config in review's cwd.** Ref mode strips `opencode.json`/`opencode.jsonc`/
   `.opencode/` from the throwaway worktree — the same `stripProjectSettings`/
   `restoreStrippedSettings` pairing dispatch uses. Scope mode never deletes the caller's
   files: an opencode-harness angle in a live checkout carrying any of those runs on the
   claude route instead, logged `review.opencode_angle_refused_config`.
3. **True read-only profile.** OpenCode `readOnly` now uses the granular `bash` permission
   object: a leading `"*": "deny"`, an allowlist of read commands (`git log/diff/show/status/
   grep/ls-files/rev-parse`, `rg`, `cat`, `ls`, `find`, `head`, `tail`, `wc`, `jq`, `curl`),
   and `"*>*": "deny"` re-denied AFTER the allows so a reader cannot become a writer via
   output redirection. `webfetch`/`websearch` are `deny` under `readOnly` (workers shell out
   via `curl`); the writable implement profile is unchanged.
4. **`settingSources` parity.** OpenCode has no `settingSources` flag; it loads
   `AGENTS.md`/`CLAUDE.md` natively but NOT user/repo skills. The review angle prompts do not
   depend on skills — verified, `server/skills/review/*` references no skill — so the logged
   ignore is acceptable as-is (no code needed).

**Method.** Seven real diffs (agent-gateway `39b4cf9`, `71377b5`; warden `afd348d`,
`fdb5886`; weatherorb `5de4e2d`, `4ea52bf`, `9bcf51b`; 2026-10-05) were replayed
one angle session at a time by `scripts/ab-review-angles.ts` (since deleted; in git history before the UI/scripts cleanup). The baseline is the
`review` route (Sonnet on Max); the cheap arm is deepseek-v4.1-flash on the
opencode harness at `variant: "high"`, read-only with the Wave-4 bash allowlist.
One blinded Sonnet judge per (case, angle) clusters the two finding lists
(randomized X/Y) and labels each cluster real/false_positive/unverifiable. Zero
failed runs, zero fallbacks. Severity mix over all findings: cheap 4 blocking /
24 discussion / 82 improvement vs Sonnet 4 / 10 / 38 — blocking counts are equal;
the cheap model's recall advantage is mostly extra improvement-level findings.
Cost per angle over the whole set: Sonnet $3.49 / $2.31 / $0.61 / $2.79
(senior-dev / typescript / frontend / qa) vs cheap $0.14 / $0.11 / $0.02 / $0.13.

**Adoption rule.** Adopt the cheap arm iff cheap recall >= Sonnet recall - 0.05
AND cheap false-positive rate <= Sonnet's + 0.1 AND cheap failures == 0 (recall =
real clusters found by the variant / real clusters in the union; fp-rate =
false-positive clusters containing the variant / all clusters containing it).

**Result per angle.**

**senior-dev**

| variant | findings | real | false_positive | unique_real | recall | fp_rate | failures | median_ms | total_cost_usd | adopt? |
|-|-|-|-|-|-|-|-|-|-|-|-|
| sonnet | 13 | 13 | 0 | 6 | 28.3% | 0.0% | 0 | 108585 | $3.4901 | — |
| cheap | 40 | 40 | 0 | 33 | 87.0% | 0.0% | 0 | 76535 | $0.1429 | yes |

**typescript**

| variant | findings | real | false_positive | unique_real | recall | fp_rate | failures | median_ms | total_cost_usd | adopt? |
|-|-|-|-|-|-|-|-|-|-|-|-|
| sonnet | 5 | 5 | 0 | 2 | 25.0% | 0.0% | 0 | 80487 | $2.3101 | — |
| cheap | 19 | 18 | 1 | 15 | 90.0% | 5.3% | 0 | 88007 | $0.1054 | yes |

**frontend**

| variant | findings | real | false_positive | unique_real | recall | fp_rate | failures | median_ms | total_cost_usd | adopt? |
|-|-|-|-|-|-|-|-|-|-|-|-|
| sonnet | 7 | 7 | 0 | 5 | 58.3% | 0.0% | 0 | 80503.5 | $0.6148 | — |
| cheap | 9 | 7 | 1 | 5 | 58.3% | 12.5% | 0 | 58151.5 | $0.0245 | no |

**qa**

| variant | findings | real | false_positive | unique_real | recall | fp_rate | failures | median_ms | total_cost_usd | adopt? |
|-|-|-|-|-|-|-|-|-|-|-|-|
| sonnet | 27 | 27 | 0 | 9 | 55.1% | 0.0% | 0 | 89670 | $2.7853 | — |
| cheap | 42 | 40 | 0 | 22 | 81.6% | 0.0% | 0 | 90469 | $0.1292 | yes |

Adopted:
`senior-dev`, `typescript`, `qa` — each clears the rule by a wide margin at
~1/25th the cost. NOT adopted: `frontend` — recall tied at 58.3% but its
false-positive rate was 12.5% vs Sonnet's 0%, so the fp clause fails; `frontend`
stays on `review`. This matches `DEFAULT_ROUTES`: `ANGLE_OC` for the three,
`JUDGE` for `frontend`.

**Caveats.** Single judge (Sonnet, blind to variant); one run per cell; no ground
truth beyond the judge. `frontend` ran only the three weatherorb diffs and does
not meet the >=5-case bar, so its "not adopted" is weaker evidence than the three
adoptions.

**Re-run** (restore the script from git history first). `bun scripts/ab-review-angles.ts --cases <json> --out <dir>` (cases =
`[{ repo, name, base, head }]`; the harness creates and removes a throwaway
worktree per case — no server, jobs or `make reload`). Needs `IU_API_KEY` and
`IU_BASE_URL` in the environment; the Keychain is not readable from a headless
shell, so supply both from 1Password via the `secrets` helper (`secrets-run read`).

## Route history (moved from routing.ts)

Dated evidence and measurement narratives behind each tier in
`server/lib/routing.ts`, moved here verbatim-ish so the code keeps only
one-line "why" comments. Tier names (CLASSIFY, AGENT_OC, JUDGE, PROSE, VISION,
SINGLE_SHOT) match the constants in that file.

### CLASSIFY

*Wave 10 (2026-10-15): the tier is now Haiku 5.5 EU on OpenCode and also carries excalidraw and narrative — § Wave 10 below. What follows is the history of the `claude -p` tier it replaced.*

CLASSIFY: cheap mechanical work (check, overview) —
Haiku 4.5 over IU (the live id is in `GET /api/routing`; DeepSeek-V4-Flash until Wave 5), thinking capped at 2048
tokens (`thinkingTokens` — see the module-header comment on `MAX_THINKING_TOKENS`; unset
would run the gateway model's `max` reasoning default, its worst setting, on work that is
meant to be cheap).
2026-09-23: moved off glm-5.3-flash on the owner's instruction, which retires GLM from
this server entirely — the same in-loop-speed complaint the AGENT note below measured
(13.3 tok/s, 38m24s on ccbench's 10-task suite vs DeepSeek-V4-Flash's ~190 tok/s, 6m20s)
applies here too, and it is the model that stalled an 84-minute dispatch episode on
2026-09-15. No separate CLASSIFY-tier measurement was run: this is the same id AGENT
already carries, at a lower thinking budget, on strictly easier work. `GLM_FLASH` stays
exported as a named id, but it is unverified in the registry, so a
`AGENT_GATEWAY_MODEL_<TOOL>=glm-5.3-flash` override is now refused.
2026-10-06: moved to Haiku over IU (`claude-haiku-4-5`, same Haiku-on-Max reverse lane). From
2026-10-04 IU rejected DeepSeek-V4-Flash over `claude -p` (`[claude-code:unrecognized_model]`,
then a Requesty 400 "Invalid request"), so every check/overview job fell to Max mid-stream,
and the route sat in `degradedRoutes`. The opencode shape AGENT_OC uses was tried for
`check` first and rejected: its worker's read-only bash profile cannot run `make`. Measured:
a `check` of warden (`make check`, ~138s bare) passed on Haiku/IU in 220s with no fallback.

### AGENT

AGENT: dispatch ONLY. 2026-09-11: owner decision moved dispatch off a
`AGENT_GATEWAY_MODEL_DISPATCH` `.env` override onto glm-5.3-flash over IU (same model
CLASSIFY already trusted), on ccbench scoring it 10/10 on the agentic coding suite.
2026-09-21: moved again, to DeepSeek-V4-Flash, on evidence measured 2026-09-20 by
modelpick ccbench plus a warden POC (Anthropic leg, corrected context env). The
owner's standing complaint with glm in this seat was in-loop speed, in both
interactive and dispatched use, and the numbers back it: ccbench's 10-task suite put
DeepSeek-V4-Flash at composite 1.00, 6m20s wall, ~190 effective in-loop tok/s, $0.09,
4% tool-error, zero compactions, against glm-5.3-flash's 0.81, 38m24s, 13.3 tok/s,
$0.035. DeepSeek-V4-Pro (the owner's first instinct) was rejected on evidence, not
preference: it ties Flash on every refreshed external index (AA coding index 68.8 vs
69.1, terminal-bench 0.787 both), runs ~3x slower and ~7x the cost in ccbench, and
produced one 5-minute idle stall in that run (the CLI auto-backgrounded a long Bash
call, then the model waited silently) — exactly the shape this lane's idle watchdog
turns into a verdict-less kill. The POC ran the same six read-only "decide this open
PR" briefs through warden→agent-gateway on both: 12/12 done, no stalls, Flash 0.7–2.9 min
per episode vs Pro's 1.0–6.0, and Flash's verdicts matched an independent Sonnet
review more often — Pro waved through two PRs that review had flagged. Honest
caveat: on the external indices glm-5.3-flash still leads both DeepSeek V4 ids (AA
coding index 71.5) — this is a speed-for-a-little-capability trade, and the models
that beat glm on both (kimi-k3, deepseek-v4.1-flash) are OpenAI-route only,
unreachable from `claude -p`. claude-sonnet-5[1m] on Max stays the reactive fallback
— this is what moves dispatch off the Max subscription onto metered IU. Thinking
stays capped at 8192 tokens (`thinkingTokens`) — the budget DeepSeek-V4-Flash's
benchmark rows above were measured under, and still more room than a classify-shaped
call needs while not defaulting to a gateway model's unbounded `max`. Deliberately
NOT extended to review or otel — see JUDGE below.

### AGENT_IMPLEMENT / AGENT (retired)

AGENT_IMPLEMENT / AGENT — RETIRED 2026-09-24, replaced by AGENT_OC / AGENT_OC_IMPLEMENT
below. History kept as comment text since the constants themselves are now dead code
(nothing references them — deleted rather than left unused):

AGENT_IMPLEMENT: dispatch's implement tier only — investigate/author stayed on AGENT.
2026-09-22: split off on the owner's explicit instruction, mirroring what was then
warden's own `AUTO_IMPLEMENT_MODEL` (default DeepSeek-V4-Pro, warden/scripts/triage.py;
since removed — warden now sends no model key and agent-gateway routes each tier), which
at the time ran implement-tier episodes on Pro via a per-job model override — this made
it agent-gateway's own default too instead of relying on every caller to remember the
override. Tension noted honestly, not papered over: the 2026-09-21 measurement in the
AGENT comment above rejected Pro for this exact seat on evidence (ties Flash on the
external indices, ~3x slower and ~7x the cost in ccbench, one 5-minute idle stall, and
Pro waved through two PRs an independent review had flagged). That split was a policy
call for the higher-stakes write tier, not a new measurement overturning the AGENT one.
{ model: "DeepSeek-V4-Pro", backend: "iu", fallback: { backend: "max", model: SONNET },
transport: "session", thinkingTokens: 8192 } — the model id string is kept only as
history text here; the `DEEPSEEK_PRO` constant itself was removed 2026-09-24 (unused
once this tier retired — nothing else in the codebase referenced it).

### AGENT_OC / AGENT_OC_IMPLEMENT

*2026-10-24: AGENT_OC_IMPLEMENT is gone — `dispatch_implement` is Max-only (owner rule: no code written on IU tokens), `dispatch_editorial` points at AGENT_OC. What follows is history.*

_Superseded by § Wave 5 for the model: dispatch and the OC review angles run `claude-haiku-5-5-eu`; the decision record below is the 2026-09-24 flash move._

AGENT_OC / AGENT_OC_IMPLEMENT — dispatch (investigate/author) and dispatch_implement,
2026-09-24. Owner decision, moving dispatch off `claude -p` entirely onto the OpenCode
harness (HTTP sessions on the shared OpenCode server, opencode-runner.ts) running `deepseek-v4.1-flash` over the IU
endpoint's OpenAI-compatible route (`iu-chat/deepseek-v4.1-flash`) — a DIFFERENT id and a
DIFFERENT transport from AGENT's `DeepSeek-V4-Flash` over the IU native Anthropic
transport above; `claude -p` cannot reach this id at all, hence the new harness rather
than a model-only swap. Evidence: the same three implement briefs re-run from Pro's
(AGENT_IMPLEMENT's) base commits, OpenCode+deepseek-v4.1-flash vs DeepSeek-V4-Pro on
`claude -p` — vps $2.46/10min vs $0.06/5min; research-gateway #21 $11.01/28min vs
$0.10/5min (max effort $0.11); weatherorb $5.39/21min vs $0.06/5min. A blind diff
review preferred OpenCode's output on 2 of 3 (research-gateway: max effort variant
closed a gap Pro's diff left open, 479/0 tests; weatherorb: tied/won, did an AGENTS.md
update Pro skipped, 1872 tests passed) and lost one (vps: inverted volume-floor logic
in a HyperDX config — not a clean sweep, recorded honestly). Cache hit 95–98% on this
route vs V4-Pro's 8% on the Anthropic route. Gateway-measured rates for
deepseek-v4.1-flash: $0.15/MTok input, $0.60 output, ~$0.003 cache read (now the
registry's rate, server/lib/models.ts, used by opencode-runner.ts's cost computation, since opencode has no --json-schema envelope to
read a CLI-computed cost from). `variant` is opencode's reasoning-effort knob:
investigate/author at "high" (AGENT_OC), implement at "max" (AGENT_OC_IMPLEMENT) —
mirroring AGENT_IMPLEMENT's own higher-stakes-write-tier split above. Fallback stays
claude-sonnet-5[1m] on Max — a fallback attempt always runs the `claude` harness (see
the module header's Harness paragraph), so a lane switch here is model AND harness AND
transport all changing at once, same as it already was reaching Max from AGENT/
AGENT_IMPLEMENT's IU-native-Anthropic primary.

### Wave 5 — Haiku 5.5 EU on the OpenCode harness (2026-10-14)

`dispatch`, `dispatch_implement` and the three OC review angles (senior-dev, typescript, qa)
moved from `deepseek-v4.1-flash` to `claude-haiku-5-5-eu`, served by the `iu-anthropic`
OpenCode provider (`@ai-sdk/anthropic` on IU's native `/anthropic` leg, so `cache_control` is
injected). `dispatch_implement_escalation` stays on `DeepSeek-V4-Pro`; `triage`, `review_router`
and `review_ocr` stay on `deepseek-v4.1-flash`; `check` stayed on `claude-haiku-4-5` until Wave 10 (§ Wave 10).

**Method.** `scripts/bench-routes.ts` drives `runSession` against the shared OpenCode server, one
fresh history-less tree per cell, 2 reps, three arms (flash at variant max/high, Haiku 5.5, Pro at
max/high). Tasks: three implement briefs replayed from this repo's history (acceptance = the fix
commit's reference tests + `oxfmt --check`), three read-only investigate questions graded by
required substrings, and the pipeline's own senior-dev/typescript/qa angle prompts over two real
commits scored by how many of the defects the repo's later fix commits corrected a finding names
(regex hints — a proxy; `findings.json` per cell). Raw: `~/.local/share/agent-gateway/bench/wave5-*`.

| arm | implement pass | median s | mean cost | investigate pass | median s | mean cost | review-angle pass | median s | mean cost |
|-|-|-|-|-|-|-|-|-|-|
| deepseek-v4.1-flash | 5/6 | 163 | $0.0172 | 5/6 | 6 | $0.0035 | 12/12 | 91 | $0.0198 |
| claude-haiku-5-5-eu | 6/6 | 26 | $0.0093 | 6/6 | 5 | $0.0007 | 11/12 | 18 | $0.0032 |
| DeepSeek-V4-Pro | 6/6 | 129 | $0.0609 | 6/6 | 11 | $0.0152 | 11/12 | 113 | $0.0521 |

Cache reads: Haiku 100%, flash 51–97%, Pro 64–98%. Flash's two misses were an `oxfmt`-dirty
diff and a non-JSON final message; Haiku's one review miss was a ```json-fenced answer
(production's `extractJson` recovery tolerates it); Pro's one miss was an opencode-server
request timeout under load. Angle recall on the hint proxy was level across arms (~2 of 4 groups).

**Caveats the route carries.** (1) Haiku 5.5 bills 5x ($0.50/$2.50, cache read $0.05) above 100K
prompt tokens PER REQUEST; the measured mean per-request prompt was 38–64K, so a long episode
costs more than the registry's under-100K rate. Re-measure if episodes grow. (2) The `-eu` id is
Bedrock eu-west-1 only; Max cannot serve it, so the reverse lane stays Sonnet on Max. (3)
OpenCode's anthropic package sends `thinking.block_binding` plus the `thinking-binding-controls`
beta, which IU's gateway answers with 503 `not_found_error` for the `-eu` id (it falls through to
an upstream with no such id); `compatibility.supportsThinkingBlockBinding: false` in the v2-shaped
provider entry removes both (the v1 `provider` form drops that key — `buildOpencodeServerConfig`
emits every provider under `providers` now). With it, no `thinking` field is sent.

**`check` on Haiku 5.5 over `claude -p`: rejected (superseded by Wave 10, where it runs on OpenCode).** On `claude -p` (`scripts/bench-check.ts`, explicit
format/lint/typecheck commands, 3 runs each) Haiku 4.5 took 60 s median, Haiku 5.5 EU 237 s with
one turn and no usage row — the `claude` harness sends enabled-budget thinking, which the `-eu`
id's gateway leg handles slowly. The model is only in the loop for explicit `commands` or a repo
without a `make check` target anyway; the repo-contract `make check` path is deterministic.

### Wave 10 — the claude-harness routes move to OpenCode (2026-10-15)

`check`, `overview`, `narrative`, `excalidraw` and `dispatch_editorial` moved to
`claude-haiku-5-5-eu` on the OpenCode harness (Sonnet on Max stays the reverse lane). `otel` stays
on Claude, as does the `frontend` review angle; `review` (synthesis and every angle without its own
route key) moved too — § `review` below. The CLASSIFY tier now carries no `thinkingTokens`
(opencode has none).

**Method.** One fixed real input per tool through the production handler, route chosen by env
(`scripts/bench-check.ts`, `scripts/bench-tool.ts`; raw output and per-rep JSON under
`~/.local/share/agent-gateway/bench/wave10/`). Candidates: the old route, Haiku 5.5 EU and
`deepseek-v4.1-flash`, both on OpenCode. Cost is the runner's own number (notional for Max rows).

| tool | old route | Haiku 5.5 EU on OpenCode | flash on OpenCode |
|-|-|-|-|
| check (3 repos x clean/broken x2) | Haiku 4.5 `claude -p`: 3/4 correct, median 64 s, one 718 s run that reported a false typecheck failure, $0.10 per cell | 12/12 correct, median 5.3 s, $0.0018 per cell | 12/12 correct, median 8.1 s, $0.0016 |
| overview (46 agents, 2 reps) | 170-180 s, $0.11-0.23 | 33-35 s, $0.006 | 84-113 s, $0.012-0.016 |
| excalidraw (same brief, 2 reps) | Sonnet/Max 111-121 s, $0.13 | 23-30 s, $0.003-0.005 | 1 of 2 hydrate timeouts, 113 s |
| narrative (agent-gateway bootstrap page, 2 reps) | Sonnet/Max 48-59 s, $0.24-0.26 | 22 s, $0.006 | 35-40 s, $0.008 |
| dispatch editorial, README fold-in (2 reps) | Sonnet/Max 43 s / 99 s, 1 of 2 complete | 117 s / 90 s, 1 of 2 complete | 57 s / 60 s, 0 of 2 complete |
| dispatch editorial, numbered-checklist rewrite (3 reps, mechanically graded) | Sonnet/Max 3/3, 27-38 s | 3/3, 14-15 s, $0.003 | not run |

**Reading.** `overview`: recommendation agreement with the old route was 35-36 of 44 (80%); the old
route agrees with itself 37 of 45 (82%), Haiku 5.5 with itself 43 of 46 (93%). `excalidraw`:
8 boxes, 7-8 bound arrows, no overlaps and the requested re-attach arrow, against Sonnet's 7-11
boxes; read from geometry, not a render. `narrative`: both pages are well formed and within the
caps; Sonnet's is a little more precise on specifics, Haiku's reads more in business terms and
carried one transcript-stale claim ("server not restarted") — judged equal, n=2 pages, revert is
`AGENT_GATEWAY_MODEL_NARRATIVE=claude-sonnet-5[1m] AGENT_GATEWAY_HARNESS_NARRATIVE=claude
AGENT_GATEWAY_BACKEND_NARRATIVE=max`. Editorial: both models left the paragraph the brief asked to
fold in on one of two runs of the first brief — a tie — and tied on the second.

**What made OpenCode able to carry them.** (1) `check`: the claude prompt makes the worker define a
`run_step` shell function (mktemp/eval/kill) as its idle watchdog; no such command is on the
read-only allowlist, so the first OpenCode run was "Permission denied" on every step. The OpenCode
prompt now says "run each command directly, the host watches the session", and a new `agw-check`
permission profile (read-only plus `make`/`bun`/`uv`/`pytest`/`ruff`/`tsc`/…, a repo's
`.venv/bin`/`node_modules/.bin`; interpreters and edits stay denied, the server-self-access denies
are re-applied last) is selected by `runsChecks: true`. (2) overview/narrative asked claude for
`extraDisallowedTools: [Bash, Read, …]`, which the OpenCode runner refuses; they now also pass
`toolless: true`, selecting an `agw-toolless` profile (catch-all deny). (3) The stale-config guard
(`getOpencodeServerStatus`) now compares the running server's `/api/agent` profiles with the
config, so a profile added in code is `make verify`-red until `make install-opencode-agent` loads it.

**Stays on Claude, with the measured reason.** `otel`: it needs the bearer-authed HyperDX MCP server
in its session; OpenCode v2 has MCP only at server scope (`/api/mcp`, no field on `POST
/api/session` — the session body is `id, parentID, title, agent, model, location, metadata,
permissions`), so moving it would put the HyperDX key in the shared server every dispatch and
review worker attaches to.

**`review` moved to Haiku 5.5 EU on OpenCode (synthesis and the keyless angles).** `review`'s
synthesis session and every angle without its own route key (architect, backend, the router-picked
content angles) now take CLASSIFY: `claude-haiku-5-5-eu` on `iu`, the OpenCode harness, Sonnet on
Max as the reverse lane. `review_angle_frontend` stayed JUDGE here (Sonnet on Max, claude harness; it moved in Wave 11,
below), as does `otel`. Two real ranges through the production handler, one run per route:

| range | Sonnet on Max | Haiku 5.5 EU on OpenCode | flash on OpenCode |
|-|-|-|-|
| run 1 (HEAD~2) | 585 s, 2 blocking / 16 improvements / 4 test gaps | 298 s, 3 blocking / 12 / 4 (same top two blockers plus one more) | 521 s, 1 blocking / 19 / 6 |
| run 2 (HEAD~4) | 705 s, 2 blocking / 14 / 5 | 473 s, 3 blocking / 31 / 2 (the shared in-place-lease blocker found by both; the others differ) | not run |

n=2 ranges and no ground truth: the counts say Haiku 5.5 is not obviously worse and clearly faster,
not that it is better. Wave 11's real-findings A/B is the follow-up. Revert:
`AGENT_GATEWAY_MODEL_REVIEW=claude-sonnet-5[1m] AGENT_GATEWAY_HARNESS_REVIEW=claude
AGENT_GATEWAY_BACKEND_REVIEW=max`.

### Wave 11 — cost truth for Haiku 5.5 above 100K (2026-10-15)

**Question:** does agw's per-message repricing (`messageCostUsd`, `rate.longContext`) match what IU bills?

**Finding: IU's bill is not observable from this side; the registry matches the vendor list exactly.**
- IU's gateway exposes no usage or billing endpoint (`/v1/usage`, `/usage`, `/v1/key`, `/v1/credits`,
  `/v1/billing`, `/v1/spend`, … all 404; only `/decisions/v1/models` answers).
- Neither leg returns a cost for Haiku 5.5 EU: the Anthropic leg's `usage` carries token counts only
  (headers add Bedrock's own token counts, which agree), and the OpenAI leg (`claude-haiku-5-5`, the
  `-eu` id is refused there) returns `usage` without `cost`. The `usage.cost` that
  calibrated the OpenAI-route models in 2026-09 does not exist for this model.
- Anthropic's pricing page (via `/research`, two pages agreeing): $0.10 in / $0.50 out up to 100K prompt
  tokens; $0.50 / $2.50 above; cache write 5-min $0.125 (above: $0.625), 1-hour $0.20 (above: $1.00),
  cache read $0.01 (above: $0.05). The prompt length counts input + cache read + cache write, per
  request. That is what `messageCostUsd` implements and what the registry holds; the 1-hour write tier
  is not used (OpenCode's anthropic provider writes 5-min entries).
- Not verifiable: AWS Bedrock's own list price for the `eu` profile (its pricing page does not render
  its token tables) and IU's markup/invoice. A divergence would show only on IU's invoice.

**Decision:** no rate correction. The cost column stays "vendor list price", labelled as such. The
reconcile step, if the invoice ever disagrees: compare one month's invoice line for
`claude-haiku-5-5-eu` with `sum(costUsd)` of the `agent-gateway` sessions sink for the same month and
move `rate.longContext`/`cacheWrite` by the ratio.

### Wave 11 — the `frontend` review angle moves to OpenCode (2026-10-15)

`review_angle_frontend` was the last angle on Sonnet-on-Max (`JUDGE`): the 2026-10-05 flash A/B
had a false-positive problem and the Wave 5/10 benches measured only senior-dev/typescript/qa and the
synthesis. Re-measured on **real findings**, not regex hints: `bun scripts/bench-frontend.ts` runs the
pipeline's own `frontend` angle prompt over three real weatherorb commits (5de4e2d, 6264775, 4ea52bf; React
Native and web account UI), two reps per arm: Haiku 5.5 EU on OpenCode vs the old route (Sonnet on Max). Raw
findings, per-cell meta and the pooled side-by-side files:
`~/.local/share/agent-gateway/bench/wave11/frontend/`.

| arm | findings per rep (5de4e2d / 6264775 / 4ea52bf) | median wall | notional cost per run |
|-|-|-|-|
| Haiku 5.5 EU, opencode | 10,7 / 5,5 / 4,4 | 18 s | $0.004-0.010 |
| Sonnet, claude on Max | 3,5 / 5,3 / 1,1 | 107-169 s | $0.5-0.7 (Max is flat-rate; the figure is the API list price) |

Ground truth, the only one this set has: the fix commit `4ea52bf` ("W18 review findings") names what was
wrong in `5de4e2d`. Of its four defects, a sign-in token delivered twice turning success into failure was
named by Haiku in 2 of 2 reps (the cold-start `getInitialURL` replay) and by Sonnet in 1 of 2 (weakly); sign-out
swallowing its error by Haiku 1/2 and Sonnet 1/2; neither arm named the Measure-pan unmount leak or the
licence link opening on scroll. So recall is tied-to-better for Haiku at one ninth of the wall time. The cost
is noise: Haiku files roughly twice the findings, much of it accessibility roles and 44 dp touch targets, all
`improvement`/`discussion`; neither arm filed a `blocking` finding on any commit. Precision on 6264775 and 4ea52bf
was not judged against code (no later fix commit to anchor it), and n=3 commits is thin.

**Decision:** moved to `ANGLE_OC` (Sonnet on Max stays the reverse lane). The synthesis already folds
low-value improvements, so the extra nits cost reading time, not gates. Revert, one line each:
`AGENT_GATEWAY_MODEL_REVIEW_ANGLE_FRONTEND=claude-sonnet-5[1m] AGENT_GATEWAY_HARNESS_REVIEW_ANGLE_FRONTEND=claude
AGENT_GATEWAY_BACKEND_REVIEW_ANGLE_FRONTEND=max`. The reverted route has no IU retry (the
declared fallback is Max-to-Max and is dropped), unlike the old `JUDGE` shape; a Max outage fails the angle,
which the review retries once. Watch item: warden's review outcomes on frontend-heavy
PRs. Everything routed through `routeFor` is now off Claude except `otel`.

### dispatch_editorial

*Wave 10: the same OpenCode Haiku 5.5 route as `dispatch` (§ Wave 10); `dispatch_implement` left it 2026-10-24 and is Max-only.* dispatch_editorial — 2026-10-10. `kind: "editorial"` on a dispatch routes the episode to the Claude harness on Sonnet (Max, IU reverse fallback), the PROSE shape: AGENTS.md, docs and prose briefs are editorial judgment a cheap model was not measured on. Claude on `dispatch` itself is otherwise opt-in only (`AGENT_GATEWAY_HARNESS_DISPATCH=claude` plus a Claude `AGENT_GATEWAY_MODEL_DISPATCH`).

### escalation

*2026-10-24: superseded — `dispatch_implement` and `dispatch_implement_escalation` run on Max only (Sonnet over `claude -p`, no IU fallback); the history below is why they were on IU before.*

escalation — `dispatch_implement_escalation`, the attempt-3+ retry seat for an implement
episode (warden reads `routes.dispatch_implement_escalation.model` from `GET /api/routing`),
2026-10-05. DeepSeek-V4-Pro over the OpenCode harness, variant `"max"`, no Max fallback (a
gateway id cannot run there — the caller retries instead). Chosen over gpt-6.1-sol on
`scripts/probe-implement.ts` (deleted since; two replayed real implement briefs, one run each):
DeepSeek-V4-Pro passed both reference tests, 8/5 turns, 51 s/70 s, $0.061/$0.067; gpt-6.1-sol
passed both but at 18/19 turns, 1330 s (one run hit the 300 s idle watchdog)/594 s,
$0.32/$0.39; the deepseek-v4.1-flash baseline passed both at 31 s/97 s, $0.011/$0.016.
gpt-6.1-sol stays verified for chat/Responses only (2026-10-02) — rates/limits unchanged.

### JUDGE

*Wave 10 (2026-10-15): review's synthesis and keyless angles moved to CLASSIFY (Haiku 5.5 EU on OpenCode, § Wave 10); only the `frontend` angle and `otel` remained on JUDGE (`frontend` moved in Wave 11; only `otel` is left). What follows is the history of the tier as it stood before.*

JUDGE: judgment-heavy work that stays on Max — review's synthesis/router, the `frontend`
angle, and otel. The `senior-dev`, `typescript` and `qa` angles moved off JUDGE onto
`ANGLE_OC` 2026-10-05 after the Wave-4 A/B (above); `frontend` did not clear the adoption
rule and the synthesis/router were never in its scope. Excluded from AGENT, for different
reasons, both dated 2026-09-11:

- review: measured the same day with `AGENT_GATEWAY_MODEL_REVIEW=glm-5.3-flash`, a
  ~1000-line diff's senior-dev angle looped a single grep/sed for 17 minutes at
  80,000+ turns and never produced a synthesis — cancelled, route reverted. Multi-
  angle review over a large diff is a different workload shape from the 10-task
  coding suite AGENT's evidence came from, and it is the one tool where the cheap
  tier has actually been measured failing. A non-Claude model here would also drop
  the Max fallback entirely (Max only serves Claude ids), leaving a failing review
  with nowhere to go.
- otel: agent-gateway's one synchronous exception — it runs inline and returns to the
  caller instead of going through the job queue, so a worker that loops there
  blocks a human's interactive session, not a background ledger item. Never
  measured on a cheap model; the owner's rule is that attended/interactive work
  stays on Max (a flat subscription, free at the margin). No reason to gamble it.
  Do not "fix" this inconsistency with AGENT without new measured evidence.

### PROSE

*Wave 10 (2026-10-15): no default route uses PROSE any more — narrative, excalidraw and dispatch_editorial moved to OpenCode Haiku 5.5 (§ Wave 10).*

PROSE: editorial/generative work (narrative, excalidraw) — re-tiered 2026-09-11 the
other way: same model (claude-sonnet-5[1m]), but anchored on Max (a flat fee) instead
of paying IU per-token for it — the one metered-premium lane worth eliminating, since
Sonnet isn't the ccbench-winning model AGENT moved to. IU is the reverse fallback.
gpt-5.6-luna was considered and rejected: the IU Anthropic route (`/anthropic/v1/
messages`) that runSession requires 404s on it (checked 2026-09-11) — runSession
spawns Claude Code, which speaks only the Anthropic protocol, so a model absent from
that route can never be reached through it regardless of what the gateway serves
elsewhere.

### VISION

VISION: the IU OpenAI vision transport (read_image, read_drawing) — no runSession, no
fallback.

### SINGLE_SHOT

SINGLE_SHOT: `triage` and review's angle router — one tool-less, JSON-out completion
(`singleShotJson`, single-shot.ts) instead of a `claude -p` session, 2026-10-02. Neither
needs tools (the router now gets the diff inline), so the session was pure overhead:
20-100x the cost of one call (dotfiles docs/agent-platform.md §Agent-Gateway — the engine). Same
deepseek-v4.1-flash id review_ocr runs, registry-verified, over the iu-openai transport —
no Max lane (Max never serves it), no thinking budget (an iu-openai route has none; the
registry's `minOutput` floor on `max_completion_tokens` is what keeps reasoning from
starving the answer). `harness` is inert, as on every non-session transport.

### adversary

adversary sits alone: same iu-openai transport as VISION. deepseek-v4.1-flash since
2026-10-23 — gpt-5.6-terra before, ~$10/day of IU spend at ~150 reviews/day. A same-diff
bench at effort `high`: terra ~$0.07 / 23s / 1 finding, v4.1-flash $0.013 / 108s / 5
findings (terra's one included); the latency hides behind the angle phase. Still cross-lab
against the Anthropic angles, which is the point of the seat.

### Review depth (review_router output, gated)

The `review_router` single-shot also answers `depth` (`light` | `standard` | `deep`) and a one-line
`depthReason`. No route changes: it rides the same `review_router` call. Caller `depth` > router >
fallback `standard`. Logged always as `review.depth`. Gating is on by default
(`AGENT_GATEWAY_REVIEW_DEPTH_GATING=0` disables): the router's chosen angles run at every depth;
light drops the rest of the floor to senior-dev, standard keeps the floor, and only deep runs OCR.
The router's `deep` is deliberately narrow (auth/secrets, destructive data ops, concurrency or
crash-recovery, public contract) and defaults shallower when unsure. Replay the router over stored
reviews with `scripts/replay-depth.ts` after changing those rules; it reports lost blocking findings.
Full table and reasoning: `server/skills/review/README.md` § Depth.

### review_ocr

review_ocr: the `ocr` CLI (server/lib/ocr.ts) only ever consumes `.model` — it is not a
`runSession` worker, so there is no Max lane for it to fall back to (Max serves the
Claude Code CLI's own auth path, not an arbitrary external binary's), same reasoning as
adversary/VISION below. deepseek-v4.1-flash with ocr's `--effort low` (ocr.ts) since
2026-09-25, from a same-range bake-off (agent-gateway 819bcc7..4898afb, 1.8k lines, every
finding checked by hand). Wall time in ocr is LLM rounds × ~5s per round (the same for
every model), not tok/s: at the default effort (2 review passes) v4.1-flash explored for
117 rounds / 6m30s. With `--effort low` it ran 3× at 2m31s-3m09s with 4-7 findings,
nearly all real, and the most cross-file/config catches of any model — the class the
angle reviewers miss. Also measured: `reasoning_effort: none` 2m04s but noisier;
gpt-5.6-luna 3× 1m39s-1m53s, 4-6 real (overlaps the angles more); gpt-6-luna 3× ~1m30s,
2-3 real (terser); gemini-3.8-flash 2× ~7m, 1-3 real (84 rounds at a 3.3s IU TTFT).

OCR is paused until 2026-11-02T00:00:00Z (`OCR_PAUSED_UNTIL_DEFAULT`, owner decision 2026-10-26: the
IU API is over its $500 rolling cap). The pause is checked before every other gate, resumes by
itself with no deploy, and `AGENT_GATEWAY_REVIEW_OCR_PAUSED_UNTIL` overrides it (ISO date/time;
empty = no pause; invalid = warning, no pause). Delete the constant once it expires.

Spend gate: after the pause and before the min-lines gate, OCR is skipped while the IU rolling-30-day
spend is at or above `OCR_BUDGET_MAX_ROLLING30_DEFAULT` ($400; `AGENT_GATEWAY_REVIEW_OCR_BUDGET_MAX`,
0 = gate off). The spend comes from usage-tracker's host-side snapshot
`~/.local/share/iu-portal/latest.json` (`AGENT_GATEWAY_IU_BUDGET_FILE`; schema 1: `fetched_at`,
`rolling30_usd`, `limit_usd`), read per review. It fails closed: a missing, unreadable, malformed,
wrong-schema or >48 h old snapshot also skips, with the cause in the skipped block. Gate order:
date pause, spend gate, min lines. These decide whether OCR runs, never how much of it runs
(owner decision 2026-10-26: a capped OCR is an ineffective OCR, so there is no file, token or round cap).

ocr CLI v1.12.13 -> v1.13.3 (installed 2026-10-26, checksum-verified; the old binary is kept at
`~/.local/bin/ocr.v1.12.13` for rollback). What matters to us: ocr now has `--max-tokens-budget`
(total input+output tokens, checked before every LLM round; a group over budget gets one final round
and is reported failed(budget), v1.13.1 surfaces that stop on the run-level state). We deliberately
do not pass it: it truncates a run, and a truncated OCR is an ineffective one. Also in v1.13.x: a
grace-round task_done counts as completion (v1.13.1), deleted files are readable via
`file_read_diff` and listed under their own path (v1.13.0), and a prompt-overflow group is recorded
as a failed review (v1.13.0). Every flag `ocrArgs` passes parses unchanged (checked with
`ocr review --preview`, no LLM call). The rest (ChatGPT auth, ACP, language allowlists, MCP
pagination) does not touch our path.
