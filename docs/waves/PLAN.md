# Review spend — cut the IU cost of /review without losing the findings that matter
**Goal:** `/review`'s IU spend drops by well over half, measured on usage-tracker. Gating is decided on
replayed evidence, not on a hunch, and no blocking finding class is lost silently.
**Gate:** `make check` green; replay evidence recorded in Left behind; deploy per AGENTS.md (orchestrator's call
if it needs a restart while jobs run). **No new paid experiments beyond what replay already stored.** Any live
review run to confirm costs IU money, so at most 2, on small diffs.
Previous plan archived: `docs/waves/archive/2026-10-factory-phase0.md` (and `2026-10-opencode-v2.md`).

## Established — do not re-derive (orchestrator, 2026-10-26, from usage-tracker + modelpick)

- **The owner's IU cap is $500 over a rolling 30 days, judged on IU's portal; it stood at $573.** usage-tracker
  (`~/.local/share/usage-tracker/usage.db`, read-only) attributes the last 30 days of `billing='iu'`:
  `agent-gateway-iu` `review_ocr` (deepseek-v4.1-flash) **$197** over 1,693 runs, with 3.5 B cache-read, 211 M
  input and 123 M output tokens; per-run averages grew from ~0.8 M cache to **5–7 M** since 10-21 (10-25 avg
  6.96 M, max 33 M; output avg 207 k). `review:adversary` on gpt-5.6-terra $86 is **history**: moved to
  deepseek on 2026-10-23 (`routing.ts` ~277). `agent-gateway-opencode` `review:angle` on claude-haiku-5-5-eu
  $48 (27 k rows, 897 M cache-read), `review:synthesis` haiku $5, `review:router` $5, and the opencode lanes
  `agent-gateway:review` deepseek $15 and `review:angle` deepseek $5. **Review ≈ $370 of ~$575 tracked.**
  Query: `select substr(ts,1,10), sub_tool, model, count(*), round(sum(cost_usd),2),
  round(sum(cache_read_tokens)/1e6) from usage_record where source like 'agent-gateway%' and ts>=date('now','-30
  days') group by 1,2,3`.
- Depth classification exists (`b5c3756`): `review_router` answers `light|standard|deep`, logged as
  `review.depth`. `AGENT_GATEWAY_REVIEW_DEPTH_GATING=1` is **off** (light → senior-dev + adversary; standard →
  floor + router angles, no OCR; deep → everything + OCR). `scripts/replay-depth.ts` replays the router over
  stored reviews and reports lost blocking findings. OCR also has `AGENT_GATEWAY_REVIEW_OCR=0` and
  `..._OCR_MIN_LINES` (default 100). OCR runs `--effort low` since a 2026-09-25 bake-off
  (docs/routing-and-quota.md § review_ocr).
- Owner direction: DeepSeek stays the estate default everywhere. Keep OCR's value (cross-file and config
  findings the angles miss) where a diff earns it.

## Wave 1 — Measure, gate, trim            <!-- status: done -->
- [x] Explain OCR's per-run growth since ~10-21: correlate usage-tracker `review_ocr` rows (tokens per run) with
      review jobs (diff size, repo, scope; agent-gateway's own job store/logs). Is it larger diffs, `ocr`
      exploring whole repos (worktree vs scope), a CLI upgrade, or effort/pass settings drifting? Fix a cause
      if it is ours, e.g. pin its file scope to the diff or cap rounds/turns if the CLI allows.
- [x] Run `scripts/replay-depth.ts` over the stored corpus. Report the depth distribution, the blocking findings
      that would be lost under gating (which angle or OCR found them), and the projected spend at each depth
      using the per-run costs above.
- [x] If the replay loses no blocking finding class (or only ones another angle also catches), enable
      `AGENT_GATEWAY_REVIEW_DEPTH_GATING=1` as the default (code default and docs, not just env), so OCR runs only
      on `deep`. Otherwise propose the narrowest gate the evidence supports (e.g. raise `OCR_MIN_LINES`, OCR
      only on caller `depth=deep`) and implement that.
- [x] Look at the haiku angle cost ($48, 27 k rows): rows are per step, so check whether angles re-read the
      same files repeatedly (cache-read 897 M). Tighten only if there is a cheap, clear win.
- [x] Docs (`docs/routing-and-quota.md`, `server/skills/review/README.md`, AGENTS.md), tests, `make check`, commit,
      push. Left behind: before/after projected $/30d per sub_tool, and what the owner gives up.
**Left behind:**
- **OCR growth is diff size, not drift.** ocr session logs (`~/.opencodereview/sessions`, 1,300 runs since 10-12): prompt tokens
  scale ~0.23 M per reviewed file (0.7 M at 1-3 files, 1.7 M at 4-8, 3.1 M at 9-15, 5.4 M at 16-30, 10.5 M at 31+); files/run went
  ~8 -> 19-29 on 10-22..26 (whole-wave reviews, mostly prometheus-epx). Tool calls/LLM turns scale with files too. CLI unchanged
  (v1.12.13, built 10-08), effort still `low`, no repo-wide drift. Separate volume spike: 10-13..19 ran 140-200 OCR runs/day
  (~$110 of the $197) on small diffs. Nothing of ours to pin; the lever is how often OCR runs.
- **Replay (`scripts/replay-depth.ts`, router IU $0.24, 18 of 44 reviews routable; rest are torn-down worktrees/uncommitted):**
  old prompt in production logs, 103 `review.depth` events: deep 71 routed + 14 fallback, standard 24, light 8: ~69% of routed reviews
  deep, so gating alone saved little. New narrower prompt on the replay: deep 11, standard 5, light 2. Lost blocking
  findings under gating: 2, both on modelpick `03152018` (`light`, found only by resilience/typescript). Fixed by making `light`
  keep the router's individually chosen angles; no OCR-only finding class was lost (the one OCR-only catch, `db29a4c7`, is deep).
- **Shipped:** depth gating default-on (`..._DEPTH_GATING=0` opts out); OCR only at `deep`; router `deep` narrowed (auth/secrets,
  destructive data/migration, concurrency/crash-recovery, public contract with outside callers; "several files" is not deep; unsure
  -> shallower); router-failure fallback `standard` (was `deep`, so a router outage ran OCR); `light` = senior-dev + routed angles.
- **Projected $/30d (assumes the 61% deep share of the small replay holds, which is optimistic for the auth-heavy repos sampled):**
  review_ocr $197 -> ~$120 (-$77); angles (haiku $48, deepseek $5) and synthesis ~unchanged (floor still runs at standard; light
  trims a few angles, ~$3); adversary/router unchanged. Total review ~$370 -> ~$290, **not** "well over half". Gating alone does not
  reach the goal; the deep share is the lever.
- **Haiku angles:** 32.5 k rows, 899 M cache-read vs 196 M cache-write (4.6 reads per write): normal agentic-loop reuse, no repeated
  whole-file re-reads to cut. No change.
- **Owner gives up:** OCR on standard/light diffs (its cross-file/config-drift catches there), router-failure reviews no longer
  get OCR. `make check`: 2038 pass, 1 fail, `GIT_DENY_CREDENTIALS_ENV` in `tests/dispatch-worktree.test.ts:1121` (fails identically
  on clean master with the mini's headless gitconfig; not touched here).
- **Open for the orchestrator:** to get under half, either an OCR file cap (e.g. skip/limit OCR above ~30 files, where it costs
  $2-3 per run) or opt-in OCR (`depth=deep` from the caller only). Needs a deploy (`make reload`) to take effect; not done.
