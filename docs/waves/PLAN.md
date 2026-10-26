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

## Wave 1 — Measure, gate, trim            <!-- status: active -->
- [ ] Explain OCR's per-run growth since ~10-21: correlate usage-tracker `review_ocr` rows (tokens per run) with
      review jobs (diff size, repo, scope; agent-gateway's own job store/logs). Is it larger diffs, `ocr`
      exploring whole repos (worktree vs scope), a CLI upgrade, or effort/pass settings drifting? Fix a cause
      if it is ours, e.g. pin its file scope to the diff or cap rounds/turns if the CLI allows.
- [ ] Run `scripts/replay-depth.ts` over the stored corpus. Report the depth distribution, the blocking findings
      that would be lost under gating (which angle or OCR found them), and the projected spend at each depth
      using the per-run costs above.
- [ ] If the replay loses no blocking finding class (or only ones another angle also catches), enable
      `AGENT_GATEWAY_REVIEW_DEPTH_GATING=1` as the default (code default and docs, not just env), so OCR runs only
      on `deep`. Otherwise propose the narrowest gate the evidence supports (e.g. raise `OCR_MIN_LINES`, OCR
      only on caller `depth=deep`) and implement that.
- [ ] Look at the haiku angle cost ($48, 27 k rows): rows are per step, so check whether angles re-read the
      same files repeatedly (cache-read 897 M). Tighten only if there is a cheap, clear win.
- [ ] Docs (`docs/routing-and-quota.md`, `server/skills/review/README.md`, AGENTS.md), tests, `make check`, commit,
      push. Left behind: before/after projected $/30d per sub_tool, and what the owner gives up.
**Left behind:**
