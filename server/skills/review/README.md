# Multi-Angle Review Pipeline

Deep code review via parallel specialist agents, synthesized into a single actionable verdict.

## How It Works

```
Phase 1 — Data Gathering (parallel shell, ~2s)
├── git diff (scope-aware; "uncommitted" also splices in untracked files)
├── fallow review --brief --quiet --base <scope-derived base> (static analysis)
├── react-doctor (React repos only; pinned install, diff-scoped, advisory — see below)
└── package.json (test script detection)

Phase 1b (parallel sidecar, started right after Phase 1, ~3-7 min) — OpenCodeReview
└── `ocr review` (alibaba/open-code-review CLI) on the `review_ocr` route's model over IU —
    awaited only just before synthesis, so its wall time overlaps the router +
    angle phases instead of sitting in front of them. `AGENT_GATEWAY_REVIEW_OCR=0`
    disables it.

Phase 1.5 — Angle Routing (one triage call on the `review_router` route (IU), ~10-20s)
└── Reads the diff, adds content-driven angles on top of the deterministic floor
    (skipped when the caller passes an explicit `angles` list)

Phase 2 — Angle Reviews (parallel angle sessions, each on its angle's own route, capped at 3 in flight)
├── Architect           ← always (floor)
├── Senior Dev          ← always (floor)
├── Frontend Expert     ← if .tsx/.jsx/.css in diff (floor)
├── Backend Expert      ← if api/**/*.ts or server/**/*.ts in diff (floor)
├── TypeScript Expert   ← if .ts/.tsx in diff (floor)
├── QA Engineer         ← if project has test script (floor)
├── Security Reviewer   ← router, if the diff touches auth/secrets/input/etc.
├── Performance         ← router, if the diff has hot paths / scaling cost
├── Concurrency         ← router, if the diff has races / shared state / fan-out
├── Data & Migration    ← router, if the diff touches schema/migrations/data
├── API Contract        ← router, if the diff changes public API shape
└── Resilience          ← router, if the diff touches crash/restart/deploy paths

Phase 2b (parallel sidecar) — Adversary Critic
└── Single non-agentic call on the `adversary` route's model via IU OpenAI transport — the only
    cross-family reviewer in the pipeline. Always runs unless disabled.

Phase 3 — Synthesis (single session on the `review` route's model, ~15s)
└── Deduplicates, resolves conflicts, classifies findings
```

Each Phase 2 angle session is **retried once** on failure (`ANGLE_MAX_ATTEMPTS = 2`).
`session-runner`'s own ladder retries only transport-class errors, so a non-transport
failure — an idle-watchdog kill on a session route, a malformed final message — is
returned as final and would otherwise force the whole review to `needs-human`/`blocker`
on a single flaky attempt; the retry is logged as `review.angle_retry`. A **second**
failure stands: the angle is recorded as failed and the post-synthesis safety net
escalates the review to `needs-human`/`blocker`.

## Agent Selection

Selection has two layers. A **deterministic floor** is picked from changed file
extensions (instant, free, always covers the basics). A **triage router** then
adds content-driven angles that file types can't detect — it reads the diff once
on `routeFor("review_router")` (one tool-less single-shot call, the cheap triage model over the IU
OpenAI transport, the diff inline in the prompt — no worker session, no Max lane) and returns the extra angles it judges relevant. Total angles are
capped at `MAX_ANGLES` (8); the floor is kept first, router extras fill the rest.

The router prompt carries an **ISO/IEC 25010:2023 coverage checklist** — the nine quality
characteristics mapped to the angle that owns each one. It is a prompt for the router's
judgment, not a quota: its job is to stop routing collapsing into "security or nothing" by
naming the dimensions (recoverability, installability, fail-safe defaults) that neither file
extensions nor reviewer habit surface on their own.

Use the 2023 names, not the widely-circulated Nov 2022 draft chart: that edition renamed
_Usability_ → **Interaction capability** and _Portability_ → **Flexibility**, added **Safety**,
and replaced _maturity_ with _faultlessness_ and _UI aesthetics_ with _user engagement_.

**Known coverage gap:** Interaction capability routes to `frontend`, which is a _floor_ angle
picked by file extension. A change that degrades user assistance, error messages or
self-descriptiveness without touching `.tsx/.jsx/.css` — a CLI flag, an API error string, a log
message — therefore has no reviewer that owns it. Adding a thirteenth angle for it is not
obviously worth a worker slot on this repo's diffs; revisit if it starts costing findings.

Pass an explicit `angles` array to force a fixed set and skip the router (useful
when re-running a review). The baseline architect + senior-dev are always kept.

### Floor (deterministic, by file extension)

| Agent      | Trigger                         | Focus                                                                            |
| ---------- | ------------------------------- | -------------------------------------------------------------------------------- |
| Architect  | always                          | Structure, coupling, deep modules, ports & adapters, DDD, layer violations       |
| Senior Dev | always                          | Readability, complexity, nesting, Sandi Metz rules, KISS, dead code              |
| Frontend   | `.tsx/.jsx/.css`                | React patterns, re-renders, a11y, UX, SEO, TanStack Query/Router/Start           |
| Backend    | `api/**/*.ts`, `server/**/*.ts` | Elysia patterns (method chaining, encapsulation, guards), API design, validation |
| TypeScript | `.ts/.tsx`                      | Type safety, generics, async, race conditions, null safety                       |
| QA         | `test` script in package.json   | Test coverage gaps (unit/integration/e2e), edge cases, regression risk           |

### Router (content-driven, picked by `router.md` from the diff)

| Agent            | Picked when the diff…                                                            |
| ---------------- | -------------------------------------------------------------------------------- |
| Security         | touches auth, secrets, crypto, input validation, injection, file/env handling    |
| Performance      | adds hot paths, N+1 queries, unbounded work, scaling-sensitive rendering         |
| Concurrency      | adds races, shared mutable state, `Promise.all` fan-out, retries/idempotency     |
| Data & Migration | changes schema, migrations, ORM models, backfills, serialization formats         |
| API Contract     | changes public API shape, request/response schema, versioning, error contracts   |
| Resilience       | touches persisted/in-flight state, cleanup, timeouts/retries, or the deploy path |

### Depth (router-judged, gating on by default)

The router picks angles individually and also answers `depth`: `light` (mechanical, docs,
test-only, renames, config values, or covered plainly by tests/lint), `standard` (the default:
ordinary feature/fix logic, including multi-file) or `deep` (rare: auth/secrets, destructive data
ops or migrations, concurrency/crash-recovery, a public contract with callers outside the diff).
Intent and risk decide it, not line count; when unsure the router picks the shallower depth. A
caller's `depth` input wins over the router's; with neither (router failed or explicit `angles`)
the review is `standard`. The effective depth is logged on `review.depth`
(`{depth, source: caller|router|fallback, reason, changedLines, gating}`).

Depth is a gate by default; `AGENT_GATEWAY_REVIEW_DEPTH_GATING=0` turns it off (everything runs,
OCR included, depth only logged). The router's individually chosen angles run at every depth:

| Depth      | Angles run                             | OCR                                        |
| ---------- | -------------------------------------- | ------------------------------------------ |
| `light`    | senior-dev + router angles + adversary | off                                        |
| `standard` | floor + router angles + adversary      | off                                        |
| `deep`     | floor + router angles + adversary      | on (≥100 changed lines, ≤30 changed files) |

fallow and react-doctor run at every depth. Explicit `angles` still choose the angle set; the
gate then only decides OCR. `scripts/replay-depth.ts` replays the router over stored done reviews
(read-only jobs.db, rebuilt diffs, router call only, $1 IU budget) and reports which blocking
findings a gated depth would have lost. Re-run it after changing the router's depth rules.

External tools run in parallel with agents:

- **fallow review --brief** — dead code, complexity, duplication (if installed; needs a
  remote only when the scope has no explicit base to hand it — see `fallowBaseFor`)
- **react-doctor** (`server/lib/react-doctor.ts`) — React-specific bugs/perf (refs mutated in
  render, missing effect cleanup, re-render traps) via the pinned binary
  `~/.local/share/agent-gateway/react-doctor/<version>/node_modules/.bin/react-doctor
  --scope changed`, same base as fallow resolved to an OID. Installed by
  `scripts/install-react-doctor.sh` (`make install-react-doctor`, also run by `make deploy`
  and `make install-cli`); never `bunx` — its shared install cache races under concurrent
  reviews (`Failed to link <pkg>: EEXIST`, 14% of runs, measured 2026-10-19). Upgrade: bump
  `REACT_DOCTOR_VERSION`, run the install target. Runs only when a tracked
  `package.json` lists `react` and the pinned binary exists; never a gate; fed to synthesis only
  (angles do not see it). `--no-telemetry` is mandatory (no repo data to their score API);
  complexity/export-style rules are filtered because fallow owns complexity. A failure
  renders an explicit `react-doctor failed` line.
- **OpenCodeReview (`ocr`)** — cross-file consistency, config drift, precise line-anchored
  findings (if installed on PATH; `AGENT_GATEWAY_REVIEW_OCR=0` disables; skipped below
  100 changed lines, `AGENT_GATEWAY_REVIEW_OCR_MIN_LINES` overrides; skipped above 30 changed
  files, `AGENT_GATEWAY_REVIEW_OCR_MAX_FILES` overrides, 0 = no cap; paused until
  2026-11-02 (IU cap cooldown), `AGENT_GATEWAY_REVIEW_OCR_PAUSED_UNTIL` overrides, empty = no pause)

## Output Schema

```json
{
  "outcome": "clean | actionable | needs-human",
  "blocking":     [{ "file", "line?", "message", "angle" }],
  "improvements": [{ "file", "line?", "message", "angle" }],
  "discussions":  [{ "file", "line?", "message", "angle" }],
  "testGaps":     ["file — type: scenarios"],
  "summary":      "2-3 sentence assessment"
}
```

### Three-Tier Action Classification

| Category       | Meaning                                                                | Who acts                          |
| -------------- | ---------------------------------------------------------------------- | --------------------------------- |
| `blocking`     | Demonstrated defect in the changed lines, confirmed at `file:line`     | Must fix — implementation agent   |
| `improvements` | Code quality, readability, design opinions (ranked, at most 5)         | Optional follow-up                |
| `discussions`  | Owner-only decisions (product, irreversible data, spend, other people) | Human decides                     |
| `testGaps`     | Missing test coverage                                                  | Implementation agent writes tests |

### Outcome Values

The outcome is **derived in code** from the lists after the synthesis JSON is parsed
(`deriveOutcome`/`applyVerdictRules` in `server/jobs/handlers/review.ts`); the prompt asks for the
same rules, but a differing model outcome is overridden and logged `review.outcome_override`.

| Outcome       | Means                                                                  | Action                          |
| ------------- | ---------------------------------------------------------------------- | ------------------------------- |
| `clean`       | No blocking findings, no discussions, every reviewer ran               | Ship it (improvements optional) |
| `actionable`  | At least one blocking finding, no discussions                          | Fix the blocking items, ship    |
| `needs-human` | Has owner-only discussions, or a reviewer failed (after its one retry) | Human reviews discussions first |

`clean` does NOT mean zero findings: improvements and test gaps are optional follow-ups and never
justify a re-review. Improvements are capped at 5 (synthesis ranks by value; code keeps the first 5
and appends "+N lower-value improvements omitted" to the summary).

**Blocking bar.** A demonstrated defect (wrong behaviour, crash, data loss, security hole, type
error) in the CHANGED lines, confirmed by the synthesizer opening the cited `file:line`. Copy,
formatting/whitespace, naming, style, hypothetical edge cases without a trigger and pre-existing
issues outside the diff are improvements or dropped.

**Adversary claims.** The adversary reads only the diff. Synthesis must open the cited `file:line`
before filing an adversary claim as blocking; an unconfirmed claim is dropped or at most an
improvement prefixed `Unverified:`, never a discussion (that would force `needs-human`).

`REVIEW_SCHEMA_VERSION` stays 2: the shape is unchanged, only the meaning of `clean` widened.
warden pins the version window and confirms on `clean` or an empty `blocking`, so it needs no change.

## Rule Loading

Each agent loads project context via `--setting-sources user,project`:

- `AGENTS.md` (or `CLAUDE.md`) and `.claude/rules/` at the repo root
- User-level rules with `paths:` frontmatter auto-load based on file types

### Framework-Specific Rules

**Frontend Expert** loads (when triggered):

- `dotfiles/rules/react-best-practices.md` — 69 Vercel React rules
- `dotfiles/rules/tanstack-query.md` — query keys, caching, mutations
- `dotfiles/rules/tanstack-router.md` — type-safe routing, loaders
- `dotfiles/rules/tanstack-start.md` — server functions, SSR, middleware

**Backend Expert** loads (when triggered):

- `dotfiles/rules/elysia.md` — method chaining, encapsulation, validation
- `elysiajs.com/llms.txt` — fetched live for latest API patterns
- Selective reference files from `dotfiles/reference/elysia/` based on what the diff touches

## Cost Profile

Angle sessions resolve their route per angle (`routeForReviewAngle`): `senior-dev`,
`typescript`, `qa` and `frontend` default to the cheap OpenCode route, and so do the synthesis and the angles
without their own route key (architect, backend, content angles) via the `review` route (Haiku 5.5 EU
on OpenCode over IU per-token, Max as the reverse fallback); the Max reverse lane is Sonnet,
used only when the primary attempt fails. The router runs as one single-shot call
(the cheap triage model over the IU OpenAI transport), and the adversary critic uses the **IU OpenAI transport**
(the `adversary` route's model) directly — IU per-token, zero Max, and a different model family
so its bias profile is uncorrelated with the Claude reviewers. The live
table is always `GET /api/routing`.

| Component                                                                                  | Route           |
| ------------------------------------------------------------------------------------------ | --------------- |
| 1 router call (own `review_router` route — single-shot, no agent, same tier as `triage`)   | `review_router` |
| 2–8 angle sessions (per-angle `review_angle_*` route where one exists; 3 in flight)        | per angle       |
| 1 adversary critic (single HTTPS call, no agent)                                           | `adversary`     |
| 1 OpenCodeReview run (own `review_ocr` route, external CLI, parallel with router + angles) | `review_ocr`    |
| 1 synthesis session                                                                        | `review`        |

OCR reads the repo itself with its own tool loop rather than working off a single diff
string, so its own IU-billed token spend (`review_ocr` in the `agent-gateway-iu` usage sink) runs
**~1.5-3M tokens per run** on the `review_ocr` model with `--effort low` (~2.5-3 min on a
1.8k-line diff), mostly cache reads. ocr's wall time is LLM rounds × ~5 s, so the default
effort's second review pass doubled it — see the `review_ocr` comment in
`server/lib/routing.ts` for the full bake-off.

The adversary model (`routeFor("adversary")`, deepseek-v4.1-flash since 2026-10-23,
gpt-5.6-terra before) is a reasoning model run as a single call with no agent loop:
~$0.013 and ~108s a review, which hides behind the angle phase. Numbers and the
switch rationale: `docs/routing-and-quota.md` § adversary. Two wiring rules were
measured on terra and are kept for any reasoning model:

- **`temperature` must not be sent.** terra accepts only the default (1) and 400s
  on anything else — and the IU gateway relays that 400 as a _retryable-looking_
  503, so a stray `temperature: 0` burns every `iuFetch` attempt and then fails
  soft, silently dropping the adversary from every review while the pipeline
  still reports green.
- **`reasoning_effort` must be sent.** Omitting it is not a neutral default: it
  behaves as `"none"`, so the model answers with zero thinking while still
  billing at the reasoning tier. The adversary runs at `"high"`
  (`ADVERSARY_EFFORT`). Measured on a real 7.5K-char diff, effort decides how
  deep the critique reaches — `none`/`medium` stopped at a surface offset bug,
  `high` found the subtler token-derivation bug ~50 lines further in; `xhigh`
  doubled the thinking tokens without finding more.

Reasoning tokens bill at the output rate and are folded inside
`completion_tokens`; `normalizeUsage` splits them back out so the ledger shows
real thinking spend (a ~170-token critique carries ~4.3k reasoning tokens)
without counting a token twice.

Wall time: ~60–120s (router adds ~10-20s; phase 2 dominates and is parallel up to
`ANGLE_CONCURRENCY`; the adversary runs in parallel with phase 2, still inside
phase 2's window). Passing an explicit `angles` list skips
the router. Set `AGENT_GATEWAY_REVIEW_ADVERSARY=false` to disable the adversary.

### Why the adversary is non-negotiable by default

Every other reviewer in this pipeline is a Claude session. Same-family
reviewers share correlated blind spots — a consensus of 6 Claude angles
is not the same signal as 5 Claude angles + 1 cross-family critic. The adversary runs as a
single HTTPS call (no agent loop, no `claude -p`), so it costs cents and runs
inside phase 2's existing window while killing the implicit self-attribution
bias that same-family multi-reviewer pipelines otherwise carry.

## MCP Integration

Called via the `review` MCP tool:

```
mcp__agent-gateway__review({
  cwd: "/path/to/repo",
  scope: "uncommitted",        // or "head", "HEAD~3", "path/to/file.ts"
  context: "add retry logic",  // optional — helps catch goal mismatches
  angles: ["security", "qa"]   // optional — force a fixed set, skip the router
})
```

`pr` (a pull request number) or `branch` (a remote branch name) may be passed instead of
`scope`, to review a ref that has no local checkout — the seam an `implement` dispatch episode
needs, since its own worktree is gone by the time the branch it pushed exists. Either fetches
the ref from `cwd`'s `origin` into a throwaway read-only worktree and diffs it against the
repo's default branch; `scope` must be omitted with either. See `GET /api/review-schema` for
the published output shape (`schemaVersion`-pinned, mirrors `/api/dispatch-schema`).

The `/review` skill and `/ship` orchestrator both invoke this tool.

### Untracked files

Under `scope: "uncommitted"`, untracked non-ignored files (`git ls-files
--others --exclude-standard`) are spliced into the diff as added-file hunks via
`git diff --no-index -- /dev/null <file>`, and listed among the changed files so
angle gating sees them. Plain `git diff` omits them, which made a brand-new file
invisible to the pipeline: the agentic angle workers could still `Read` it off
disk, but the adversary is a single non-agentic call that sees only the diff
text — so a changed file importing a new module handed it an import with no
target and it filed a phantom "file missing / build break" blocking finding.

The other scopes review committed history and deliberately do **not** splice
untracked files in — there, a new file is already part of the commit, and
working-tree files are outside what the caller asked to review.

## File Structure

```
server/skills/review/
├── README.md          ← this file
├── router.md          ← triage router prompt (picks content-driven angles)
├── architect.md       ← architecture angle prompt (floor)
├── senior-dev.md      ← code quality angle prompt (floor)
├── frontend.md        ← React/frontend angle prompt (floor)
├── backend.md         ← Elysia/backend angle prompt (floor)
├── typescript.md      ← type safety angle prompt (floor)
├── qa.md              ← QA/testing angle prompt (floor)
├── security.md        ← security angle prompt (router)
├── performance.md     ← performance angle prompt (router)
├── concurrency.md     ← concurrency angle prompt (router)
├── data-migration.md  ← data & migration angle prompt (router)
├── api-contract.md    ← API contract angle prompt (router)
├── resilience.md      ← resilience & operability angle prompt (router)
├── adversary.md       ← adversary critic prompt (cross-family, IU OpenAI transport)
└── synthesis.md       ← synthesis/classification prompt

server/mcp/tools/review.ts  ← pipeline orchestration + output schema
```
