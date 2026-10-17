// ── Tiered worker routing — the ONE place a tool's model and auth backend are decided ─────
//
// Every worker session (`runSession`) and the adversary text call pick their `{ model,
// backend, fallback }` from this table, keyed by tool. Nothing else hardcodes a model id:
// the job handlers pass `routeFor("<tool>")`, the MCP tool descriptions print the same
// route, and `GET /api/routing` exposes the effective table so an operator can see what
// a flipped env var actually did.
//
// Backends: `iu` (the IU unified endpoint's native Anthropic transport — metered per
// token, serves Claude AND gateway ids like DeepSeek-V4-Flash) and `max` (the inherited
// Claude Code OAuth profile — the Max subscription, Claude ids only).
//
// Harness: `claude` (spawns `claude -p`, `session-runner.ts`) or `opencode` (a session on the
// shared OpenCode server over HTTP, `server/mcp/opencode-runner.ts`) — ONLY `dispatch`,
// `dispatch_implement`, `dispatch_editorial` and `dispatch_implement_escalation` (the AGENT_OC/
// AGENT_OC_IMPLEMENT/AGENT_OC_ESCALATION tiers below), the measured review angles (ANGLE_OC) and,
// since Wave 10, the CLASSIFY tier (check, overview, narrative, excalidraw) run on `opencode` —
// only otel stays on `claude`. The dispatch family
// defaults to `opencode`; the `claude` harness is an explicit opt-in there, reachable ONLY via
// `AGENT_GATEWAY_HARNESS_DISPATCH=claude` (paired with a Claude `AGENT_GATEWAY_MODEL_DISPATCH`)
// or the reactive `iu`→`max` reverse fallback after an IU failure — the one AUTOMATIC Claude
// path a dispatch episode has. A route's
// `variant` (opencode's reasoning-effort knob, the `provider/model#variant` suffix) is only meaningful when
// `harness: "opencode"`. A fallback attempt (the `iu`→`max` reverse lane) ALWAYS runs the
// `claude` harness, regardless of the primary route's harness — Max only ever serves a
// Claude id via `claude -p`, so a fallback onto it can never be an opencode run. See
// `session-runner.ts`'s `resolveHarness`.
//
// Fallback semantics (applied in session-runner.ts, one hop only, never a second one), purely
// REACTIVE — a session is only ever moved after a launch actually fails, never pre-empted:
//   primary `max` → `fallback.backend: "iu"`: a quota-flavoured failure before first output.
//   primary `iu`  → `fallback.backend: "max"`: the reverse lane — an IU transport failure
//     (or missing IU credentials) before first output moves the attempt onto Max, on
//     `fallback.model` when set (a gateway id cannot run on Max) or the same model when not.
// (A proactive Max-quota-ceiling pre-check used to also feed the first lane — removed
// 2026-09-08, see docs/routing-and-quota.md, do not re-add it.)
//
// `transport: "iu-openai"` marks the routes (`adversary`, `read_image`, `read_drawing`, the
// SINGLE_SHOT pair `triage`/`review_router` and `prose_review`) that never reach `runSession` at all —
// a direct IU OpenAI transport call consuming only `.model`. `transport: "iu-anthropic"` marks
// `prose_write`: one native Messages call (single-shot.ts `anthropicComplete`), the same
// fixed-transport rules, plus a model override must be an anthropic-wire id (refused at startup, not
// on every submit). `transport: "external-iu"` marks `review_ocr`: an external CLI (`ocr`,
// alibaba/open-code-review) that talks to IU's Anthropic transport itself
// (`server/lib/ocr.ts` sets `OCR_LLM_URL`/`OCR_LLM_TOKEN` from `getIuConfig()`), so it too
// only ever consumes `.model` — there is no `runSession`/backend switch for a CLI agent-gateway
// doesn't control the auth wiring of. Both transports' `backend`/`fallback` are informational
// defaults only; a `AGENT_GATEWAY_BACKEND_<TOOL>` override on either is refused rather than
// silently accepted and displayed with no effect.
//
// Env overrides, read once at module load (a flip needs `make reload`; the MCP process
// loads agent-gateway/.env itself — see server/lib/load-env.ts):
//   AGENT_GATEWAY_MODEL_<TOOL>=<id>             e.g. AGENT_GATEWAY_MODEL_CHECK=claude-haiku-4-5
//   AGENT_GATEWAY_BACKEND_<TOOL>=iu|max         e.g. AGENT_GATEWAY_BACKEND_REVIEW=iu
//   AGENT_GATEWAY_THINKING_TOKENS_<TOOL>=<n>    e.g. AGENT_GATEWAY_THINKING_TOKENS_CHECK=4096
//   AGENT_GATEWAY_HARNESS_<TOOL>=claude|opencode e.g. AGENT_GATEWAY_HARNESS_DISPATCH=claude, best paired
//     with AGENT_GATEWAY_MODEL_DISPATCH=claude-sonnet-5[1m]. dispatch's default model (Haiku 5.5 EU)
//     lists both harnesses, so a bare harness=claude is accepted (and the Wave-5 `check` bench ran it 4x
//     slower); a model reachable only via opencode (DeepSeek-V4-Pro, GPT ids) with harness=claude is
//     refused (see the cross-field validation in buildRoutingTable below)
//   AGENT_GATEWAY_VARIANT_<TOOL>=<v>            e.g. AGENT_GATEWAY_VARIANT_DISPATCH_IMPLEMENT_ESCALATION=high
// <TOOL> is the route key upper-cased. EVERY model id — default, env override or per-job
// override — is validated against the registry (`server/lib/models.ts`): an unregistered or
// UNVERIFIED id is refused (default stays, reported in `overrides` with `refused`); the
// registry's `harnesses`/`backends` also decide which (model, harness, backend) combinations
// are reachable. A `max` override on a non-Max-servable id is refused
// back to `iu` (logged via `overrides`) — Max never serves a gateway model. A
// `AGENT_GATEWAY_THINKING_TOKENS_<TOOL>` that isn't a positive integer is refused the same way.
// A `AGENT_GATEWAY_HARNESS_<TOOL>` value other than `claude`/`opencode` is refused, same as an
// unknown backend name. Both harness/variant overrides are refused on a non-`session`
// transport route (iu-openai, iu-anthropic, external-iu), same reasoning as the backend/thinking-token
// overrides above — there is no `runSession` call for either to affect. A registry entry flagged
// `singleShotOnly` (the Opus ids: evidence covers the `prose_write` seat only) is refused on every
// other route, env override or per-job `model`. AFTER every
// per-field override, `buildRoutingTable` validates the resulting model/harness COMBINATION
// against the registry: a model whose `harnesses` include `claude` but not the route's harness
// (every Claude id except those that also list `opencode`, e.g. Haiku 5.5 EU) normalizes harness to
// `claude` (implied, not refused); a model with no
// `claude` harness (deepseek-v4.1-flash, GPT ids) landing on harness `claude` is refused back
// to the tool's own defaults (no code path through `claude -p` at all). A
// `AGENT_GATEWAY_THINKING_TOKENS_<TOOL>` on a route whose (possibly just-normalized) harness is
// `opencode`, or a `AGENT_GATEWAY_VARIANT_<TOOL>` on one whose harness is `claude`, is refused —
// each knob only exists on the OTHER harness.
// The effective override list (applied + refused) is logged once at startup via
// `logRoutingOverrides`.
//
// `thinkingTokens` is a gateway model's reasoning budget on the IU leg (see
// `MAX_THINKING_TOKENS` in session-runner.ts's `buildWorkerEnv`) — `--effort`/
// `reasoning_effort`/`thinking:{type:disabled}` are all ignored by the Requesty hop, so
// this env var is the only control that reaches DeepSeek-V4-Flash (CLASSIFY, AGENT) or
// DeepSeek-V4-Pro (AGENT_IMPLEMENT) there; unset means the model's own `max` default, its worst
// setting. Only meaningful on a non-Claude route — `buildWorkerEnv` only exports it for
// one, so it is harmless (never sent) when set on a Claude route.

import { getModel, listModels, type ModelEntry } from "./models.ts";

export type Backend = "iu" | "max";

/** Which engine runs a session. `claude` → `claude -p` (session-runner.ts, the default on every
 *  route). `opencode` → a session on the shared OpenCode server (opencode-runner.ts) —
 *  see the module header's Harness paragraph. */
export type Harness = "claude" | "opencode";

export const ROUTED_TOOLS = [
  "check",
  "overview",
  "triage",
  "review_router",
  // The `prose` job's two single-shot seats: `prose_write` (anthropic wire, native Messages) and
  // `prose_review` (chat wire). Both are one tool-less call, no worker session.
  "prose_write",
  "prose_review",
  "narrative",
  "review",
  // Per-angle keys for the worker angle sessions that may be re-pointed independently of
  // `review` (synthesis, architect, security and the rest stay on `review`). Suffix = the angle
  // id with `-` → `_` (see `reviewAngleRouteKey`), so env names stay AGENT_GATEWAY_MODEL_REVIEW_ANGLE_<SUFFIX>.
  "review_angle_senior_dev",
  "review_angle_typescript",
  "review_angle_frontend",
  "review_angle_qa",
  "review_ocr",
  "adversary",
  "dispatch",
  "dispatch_implement",
  "dispatch_implement_escalation",
  "dispatch_editorial",
  "otel",
  "excalidraw",
  "read_image",
  "read_drawing",
] as const;
export type RoutedTool = (typeof ROUTED_TOOLS)[number];

export interface RouteFallback {
  backend: Backend;
  /** Model to run the fallback attempt on. Absent → the primary model (only valid when
   *  the primary is a Claude id, which both backends serve). */
  model?: string;
}

export interface ToolRoute {
  model: string;
  backend: Backend;
  fallback: RouteFallback | null;
  /** "session" (default): `runSession()` actually honors `backend`/`fallback`.
   *  "iu-openai": a direct IU OpenAI transport call (adversary, read_image,
   *  read_drawing, triage, review_router, prose_review) that only ever consumes `.model` — see
   *  the module comment above.
   *  "iu-anthropic": one native Messages call (`prose_write`, single-shot.ts
   *  `anthropicComplete`); its model must be an anthropic-wire id.
   *  "external-iu": an external CLI (review_ocr's `ocr`) that talks to IU's Anthropic
   *  transport itself, consuming only `.model` — see the module comment above. */
  transport: "session" | "iu-openai" | "iu-anthropic" | "external-iu";
  /** A gateway model's reasoning budget on the IU leg — `session-runner.ts`'s
   *  `buildWorkerEnv` exports this as `MAX_THINKING_TOKENS` for any non-Claude model, the
   *  only control that reaches DeepSeek-V4-Flash's or DeepSeek-V4-Pro's thinking depth on
   *  the Requesty hop. Absent on Claude routes (JUDGE), which control thinking a
   *  different way, and on the `iu-openai` transport routes (VISION, adversary), which
   *  never reach `buildWorkerEnv` at all. Meaningless on an `opencode`-harness route —
   *  opencode has no equivalent env control, only `variant` (below). */
  thinkingTokens?: number;
  /** Which CLI this route's `runSession` call actually spawns — see the module header's
   *  Harness paragraph and `Harness`'s doc comment. Defaults to `"claude"` on every tier
   *  below except AGENT_OC/AGENT_OC_IMPLEMENT. */
  harness: Harness;
  /** opencode's reasoning-effort variant (`provider/model#variant`; `"high"`, `"max"`, `"none"`, …)
   *  specific to the model's `opencode.json` entry (see `buildOpencodeServerConfig` in
   *  opencode-server.ts). Only read when `harness === "opencode"`; absent (undefined) on
   *  every `claude`-harness route, where thinking is controlled by `thinkingTokens`
   *  (gateway ids) or not at all (Claude ids). */
  variant?: string;
}

export const SONNET = "claude-sonnet-5[1m]";
export const HAIKU = "claude-haiku-4-5";
/** Haiku 5.5 on IU's Bedrock EU leg — OpenCode-harness only in routing (`iu-anthropic` provider).
 *  On `claude -p` this id ran 4x slower than Haiku 4.5 (237 s vs 60 s median, Wave 5), which is
 *  why it only ever serves the OpenCode harness. */
export const HAIKU_5_5 = "claude-haiku-5-5-eu";
/** Retired from every route 2026-09-23 (see CLASSIFY below); kept as a named id the
 *  registry documents but, being unverified there, refuses on any route. */
export const GLM_FLASH = "glm-5.3-flash";
export const DEEPSEEK_FLASH = "DeepSeek-V4-Flash";
/** OpenCode-harness-only id — reached over the IU OpenAI-compatible route as
 *  `iu-chat/deepseek-v4.1-flash` (opencode-server.ts's `buildOpencodeServerConfig`, opencode-runner.ts's session create),
 *  NOT the IU native Anthropic transport `DEEPSEEK_FLASH` above runs over — `claude -p`
 *  cannot reach this id at all. See AGENT_OC below. */
export const DEEPSEEK_V41_FLASH = "deepseek-v4.1-flash";
/** The escalation implement seat (attempt 3+), opencode-harness only — reached over IU's
 *  OpenAI-compatible route as `iu-chat/DeepSeek-V4-Pro`, `claude -p` cannot reach it. */
export const DEEPSEEK_PRO = "DeepSeek-V4-Pro";

// ── Tiers — named once, referenced by every tool that shares the shape, so a re-tiering
// touches one line instead of hunting down every duplicate. One-line "why" per tier; the
// dated evidence behind each lives in docs/routing-and-quota.md § Route history. ──────────
//
// CLASSIFY: cheap mechanical, structured-output or short-prose work (check, overview, excalidraw, narrative) — Haiku 5.5 EU
//   on the OpenCode harness (Wave 10 bench, docs/routing-and-quota.md § Wave 10), Sonnet on Max as
//   the reverse lane. Before: Haiku 4.5 over `claude -p` (check 45-718 s per run and one wrong
//   verdict, overview 170-180 s, ~20x the cost). (DeepSeek-V4-Flash over `claude -p` was rejected by
//   IU from 2026-10-04: unrecognized_model.) check needs the `agw-check` profile, overview/narrative
//   the tool-less one (opencode-server.ts); both are selected by the handler, not the route.
// AGENT_OC / AGENT_OC_IMPLEMENT / ANGLE_OC moved from deepseek-v4.1-flash to Haiku 5.5 EU on
//   2026-10-14 (Wave 5 bench, docs/routing-and-quota.md § Wave 5): 12/12 vs 10/12 implement + investigate
//   passes, ~6x faster, lower cost, 100% cache reads. Haiku bills 5x above 100K prompt tokens PER
//   REQUEST (measured mean 38-64K) — a long episode costs more than the registry rate says.
//   It exposes no effort variants, so these routes carry none.
// AGENT_OC / AGENT_OC_IMPLEMENT / AGENT_OC_ESCALATION: dispatch (investigate/author),
//   dispatch_implement and its attempt-3+ escalation on the OpenCode harness — cheaper and
//   faster than the retired `claude -p` agent tiers; only the escalation route carries a
//   `variant` (a route carries one only when its model's registry `effort` lists levels). The escalation route carries no Max fallback — a gateway
//   model cannot run there, so the caller retries instead. The `claude` harness is NOT a
//   default of any dispatch route: it is reached only by an explicit AGENT_GATEWAY_HARNESS_DISPATCH=claude
//   (+ Claude model) override, by `dispatch_editorial` below, or — automatically — by the Max
//   reverse fallback after an IU failure (the only automatic Claude path).
const AGENT_OC: ToolRoute = {
  model: HAIKU_5_5,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
};
const AGENT_OC_IMPLEMENT: ToolRoute = {
  model: HAIKU_5_5,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
};
const AGENT_OC_ESCALATION: ToolRoute = {
  model: DEEPSEEK_PRO,
  backend: "iu",
  fallback: null,
  transport: "session",
  harness: "opencode",
  variant: "max",
};
// ANGLE_OC: the review angles whose A/B cleared the adoption rule (senior-dev, typescript, qa on
//   2026-10-05; frontend on 2026-10-15, Wave 11 — on three real weatherorb commits Haiku 5.5 EU
//   named the defects the repo's own fix commit corrected at least as often as Sonnet on Max, in
//   ~18 s vs ~160 s) — the same cheap OpenCode shape as AGENT_OC, with the review route's Sonnet on
//   Max as the reverse lane. Evidence: docs/routing-and-quota.md § Review-angle A/B (Wave 4) and
//   § Wave 11 frontend angle.
const ANGLE_OC: ToolRoute = {
  model: HAIKU_5_5,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
};
// JUDGE: work that stays on Claude/Max — `otel` (needs a per-session MCP server, which OpenCode v2
//   has only at server scope — docs/routing-and-quota.md § Wave 10). The `frontend` review angle
//   left it in Wave 11 (ANGLE_OC).
//   review's synthesis and keyless angles (architect, backend, content angles) moved to CLASSIFY in
//   Wave 10: on two real ranges Haiku 5.5 EU found the same top blocking findings as Sonnet in
//   ~0.5-0.65x the wall time (298 s vs 585 s, 473 s vs 705 s); flash did not (1 blocking, 521 s).
//   The 2026-09-11 "cheap model fails on synthesis" measurement was GLM looping on a large diff.
// dispatch_editorial shares AGENT_OC_IMPLEMENT: Haiku 5.5 EU matched Sonnet on two editorial briefs
//   (Wave 10: README fold-in 1 of 2 complete on both, a numbered-checklist rewrite 3 of 3 on both, at
//   ~14 s vs ~30 s and ~$0.003 vs ~$0.13), so prose briefs no longer need a Claude route; the key
//   stays so `AGENT_GATEWAY_MODEL_DISPATCH_EDITORIAL` can still pin one (docs/routing-and-quota.md
//   § Wave 10).
// VISION: the IU OpenAI vision transport (read_image, read_drawing) — no runSession, no fallback.
// SINGLE_SHOT: `triage` and review's angle router — one tool-less JSON completion over the
//   iu-openai transport, no session overhead, no Max lane, `harness` inert.
// adversary sits alone: its own model, same iu-openai transport as VISION.
const CLASSIFY: ToolRoute = {
  model: HAIKU_5_5,
  backend: "iu",
  fallback: { backend: "max", model: SONNET },
  transport: "session",
  harness: "opencode",
};
const JUDGE: ToolRoute = {
  model: SONNET,
  backend: "max",
  fallback: { backend: "iu" },
  transport: "session",
  harness: "claude",
};
const VISION: ToolRoute = {
  model: "gemini-3.5-flash",
  backend: "iu",
  fallback: null,
  transport: "iu-openai",
  harness: "claude",
};

const SINGLE_SHOT: ToolRoute = {
  model: DEEPSEEK_V41_FLASH,
  backend: "iu",
  fallback: null,
  transport: "iu-openai",
  harness: "claude",
};

// PROSE_WRITE: the `prose` job's rewrite seat — one anthropic-wire Messages call over the IU native
//   route (single-shot.ts `anthropicComplete`), no Max lane. Opus 5.5 (owner decision 2026-10-17 —
//   modelpick `bench:writing`: 6/6 ok, 0 starved, judges 4.10 vs Opus 4.6's 3.96; LMArena
//   creative_writing #1 vs #4; $4/$20 vs $5/$25 per M; record: modelpick
//   docs/decisions/writing-model.md).
// PROSE_REVIEW: the review seat — a DIFFERENT lab from the writer (the job refuses the same-lab pair
//   at submit). DeepSeek V4.1 Flash because it is the one non-Anthropic id verified on the exact
//   single-shot JSON path (chat completions + json_object, probed 2026-10-02); gpt-6.1-sol is verified
//   on the Responses wire only.
const PROSE_WRITE: ToolRoute = {
  model: "claude-opus-5-5",
  backend: "iu",
  fallback: null,
  transport: "iu-anthropic",
  harness: "claude",
};
const PROSE_REVIEW: ToolRoute = {
  model: DEEPSEEK_V41_FLASH,
  backend: "iu",
  fallback: null,
  transport: "iu-openai",
  harness: "claude",
};

const DEFAULT_ROUTES: Record<RoutedTool, ToolRoute> = {
  check: CLASSIFY,
  overview: CLASSIFY,
  triage: SINGLE_SHOT,
  review_router: SINGLE_SHOT,
  prose_write: PROSE_WRITE,
  prose_review: PROSE_REVIEW,
  narrative: CLASSIFY,
  review: CLASSIFY,
  review_angle_senior_dev: ANGLE_OC,
  review_angle_typescript: ANGLE_OC,
  review_angle_frontend: ANGLE_OC,
  review_angle_qa: ANGLE_OC,
  // review_ocr: an external CLI that only consumes `.model` — not a `runSession` worker, so no
  // Max lane. `--effort low` (ocr.ts) picked by a bake-off, see docs/routing-and-quota.md.
  review_ocr: {
    model: DEEPSEEK_V41_FLASH,
    backend: "iu",
    fallback: null,
    transport: "external-iu",
    harness: "claude",
  },
  adversary: {
    model: "gpt-5.6-terra",
    backend: "iu",
    fallback: null,
    transport: "iu-openai",
    harness: "claude",
  },
  dispatch: AGENT_OC,
  dispatch_implement: AGENT_OC_IMPLEMENT,
  dispatch_implement_escalation: AGENT_OC_ESCALATION,
  dispatch_editorial: AGENT_OC_IMPLEMENT,
  otel: JUDGE,
  excalidraw: CLASSIFY,
  read_image: VISION,
  read_drawing: VISION,
};

/** True when Max can serve the id (a Claude id) — read from the registry's `backends`. The
 *  `claude` prefix survives only as the answer for an id the registry has never heard of
 *  (`session-runner.ts` still asks about arbitrary ids); routing itself validates every id
 *  against the registry first, so it never reaches that branch. */
export function isClaudeModel(model: string): boolean {
  const entry = getModel(model);
  return entry ? entry.backends.includes("max") : model.startsWith("claude");
}

/** The registry entry for an id routing has already validated. Throws (rather than casting)
 *  if that invariant ever breaks, so a bad id fails here with its name, not later as a
 *  property read on `undefined`. */
function requireModel(id: string): ModelEntry {
  const entry = getModel(id);
  if (!entry) throw new Error(`model "${id}" is not in the registry (server/lib/models.ts)`);
  return entry;
}

export type ModelValidation = { ok: true; model: ModelEntry } | { ok: false; reason: string };

/** Registry gate for ANY route model: registered AND verified. Exported so a caller that
 *  accepts a per-job `model` (dispatch/review/overview/narrative submit paths) can refuse
 *  loudly at submit — `withModel` itself never throws, it silently keeps the route. A
 *  `singleShotOnly` id passes only with `{ singleShot: true }` (the `prose_write` seat). */
export function validateModel(
  id: string,
  { singleShot = false }: { singleShot?: boolean } = {},
): ModelValidation {
  const entry = getModel(id);
  if (!entry) {
    return {
      ok: false,
      reason: `unknown model "${id}" — not in the registry (server/lib/models.ts)`,
    };
  }
  if (entry.verified === null) {
    return {
      ok: false,
      reason: `model "${id}" is registered but unverified — no probe evidence (server/lib/models.ts)`,
    };
  }
  if (entry.singleShotOnly && !singleShot) {
    return {
      ok: false,
      reason: `model "${id}" is single-shot only (the prose_write seat) — it has no evidence for any other route`,
    };
  }
  return { ok: true, model: entry };
}

/** `variant` survives a model change only when the new model exposes it. */
function variantFor(entry: ModelEntry, variant: string | undefined): string | undefined {
  return variant !== undefined && entry.effort.includes(variant) ? variant : undefined;
}

/** Registry-only: can Max serve this id? Unknown ids cannot. */
function servesOnMax(model: string): boolean {
  return getModel(model)?.backends.includes("max") ?? false;
}

export interface RoutingOverride {
  tool: RoutedTool;
  field: "model" | "backend" | "thinkingTokens" | "harness" | "variant";
  value: string;
  /** Set when the override was refused (a `max` backend on a non-Claude id, an
   *  unknown backend name, or a non-positive-integer thinking-token count); the default
   *  stayed in force. */
  refused?: string;
  /** Set when no env var named this field — it changed as a side effect of another
   *  override (a gateway model id forcing a `max` route onto `iu`). */
  implied?: string;
}

export interface RoutingTable {
  routes: Record<RoutedTool, ToolRoute>;
  overrides: RoutingOverride[];
}

const TRANSPORT_WHAT: Record<ToolRoute["transport"], string> = {
  session: "a worker session (runSession)",
  "iu-openai": "a fixed iu-openai transport (a direct fetch, not runSession)",
  "iu-anthropic": "a fixed iu-anthropic transport (a direct Messages call, not runSession)",
  "external-iu": "a fixed external-iu transport (an external CLI, not runSession)",
};

/** Why an override on a fixed (non-`session`) transport route is refused. */
function fixedTransportRefusal(
  tool: string,
  transport: ToolRoute["transport"],
  tail: string,
): string {
  return `${tool} runs over ${TRANSPORT_WHAT[transport]} — ${tail}`;
}

/** Why `entry` cannot take a model override on a fixed-transport route, or null. The
 *  `iu-anthropic` route makes a Messages call, so only an anthropic-wire id can run on it. */
function transportWireRefusal(
  tool: string,
  transport: ToolRoute["transport"],
  entry: ModelEntry,
): string | null {
  if (transport !== "iu-anthropic" || entry.wire === "anthropic") return null;
  return fixedTransportRefusal(
    tool,
    transport,
    `${entry.id} is a ${entry.wire}-wire model; only an anthropic-wire id can run there`,
  );
}

/** Pure: defaults + env overrides → the effective table. Exported for tests; the module
 *  singleton below is built once from `process.env`. */
export function buildRoutingTable(env: Record<string, string | undefined>): RoutingTable {
  const routes = {} as Record<RoutedTool, ToolRoute>;
  const overrides: RoutingOverride[] = [];
  for (const tool of ROUTED_TOOLS) {
    const base = DEFAULT_ROUTES[tool];
    let { model, backend, thinkingTokens, harness, variant } = base;
    const key = tool.toUpperCase();
    const modelOverride = env[`AGENT_GATEWAY_MODEL_${key}`]?.trim();
    if (modelOverride) {
      const check = validateModel(modelOverride, { singleShot: tool === "prose_write" });
      const refused = check.ok
        ? transportWireRefusal(tool, base.transport, check.model)
        : check.reason;
      if (refused) {
        overrides.push({ tool, field: "model", value: modelOverride, refused });
      } else {
        model = modelOverride;
        overrides.push({ tool, field: "model", value: modelOverride });
      }
    }
    const backendOverride = env[`AGENT_GATEWAY_BACKEND_${key}`]?.trim();
    if (backendOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: fixedTransportRefusal(tool, base.transport, "a backend override has no effect"),
        });
      } else if (backendOverride !== "iu" && backendOverride !== "max") {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: `unknown backend — expected "iu" or "max"`,
        });
      } else if (backendOverride === "max" && !servesOnMax(model)) {
        overrides.push({
          tool,
          field: "backend",
          value: backendOverride,
          refused: `max only serves Claude ids, not ${model}`,
        });
      } else {
        backend = backendOverride;
        overrides.push({ tool, field: "backend", value: backendOverride });
      }
    }
    // A model override can invalidate the default backend the same way — recorded, since
    // moving review/dispatch off Max onto metered IU is that override's largest side effect.
    if (backend === "max" && !servesOnMax(model)) {
      backend = "iu";
      overrides.push({
        tool,
        field: "backend",
        value: "iu",
        implied: `forced by the ${model} model override — max only serves Claude ids`,
      });
    }
    const harnessOverride = env[`AGENT_GATEWAY_HARNESS_${key}`]?.trim();
    if (harnessOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "harness",
          value: harnessOverride,
          refused: fixedTransportRefusal(tool, base.transport, "a harness override has no effect"),
        });
      } else if (harnessOverride !== "claude" && harnessOverride !== "opencode") {
        overrides.push({
          tool,
          field: "harness",
          value: harnessOverride,
          refused: `unknown harness — expected "claude" or "opencode"`,
        });
      } else {
        harness = harnessOverride;
        overrides.push({ tool, field: "harness", value: harnessOverride });
      }
    }
    // ── Cross-field validation, AFTER model/backend/harness overrides above have all been
    // applied — every route below this point has a model/harness combination the registry
    // says is actually reachable (`ModelEntry.harnesses`). `model` is always a registered id
    // here: defaults are asserted at module load, overrides were validated above.
    //
    // Session transport only: an external-iu/iu-openai route never runs a harness, so it may
    // carry any verified id with the inert default harness.
    const entry = requireModel(model);
    if (base.transport === "session" && !entry.harnesses.includes(harness)) {
      if (entry.harnesses.includes("claude")) {
        // A claude-capable id (every Claude id, DeepSeek-V4-Flash) on an opencode route:
        // opencode's providers have no code path to the Anthropic wire. Normalize + report as
        // IMPLIED, not refused — the model override (or default) is legitimate, harness just
        // has to follow it.
        harness = "claude";
        variant = undefined;
        overrides.push({
          tool,
          field: "harness",
          value: "claude",
          implied: `forced by the ${model} model — it can only run on the claude harness`,
        });
      } else {
        // The reverse: an opencode-only id (deepseek-v4.1-flash, GPT ids) on harness `claude`
        // — `claude -p` has no path to it. REFUSE whichever override actually caused it and
        // fall back to the tool's own documented default for BOTH fields — a partial revert
        // would leave the other field pointing at a combination nothing declared.
        const culprit = harnessOverride ? "harness" : modelOverride ? "model" : "harness";
        const culpritValue = harnessOverride ?? modelOverride ?? harness;
        // The culprit override already pushed a plain "accepted" entry above (the harness or
        // model block's own `else` branch) — remove it rather than leaving both a plain and a
        // refused entry for the same field in the reported list.
        const acceptedIdx = overrides.findIndex(
          (o) =>
            o.tool === tool &&
            o.field === culprit &&
            o.value === culpritValue &&
            !o.refused &&
            !o.implied,
        );
        if (acceptedIdx !== -1) overrides.splice(acceptedIdx, 1);
        overrides.push({
          tool,
          field: culprit,
          value: culpritValue,
          refused:
            `${model} is reachable only via the ${entry.harnesses.join("/")} harness (${harness} ` +
            `cannot run it) — pair AGENT_GATEWAY_HARNESS_${key}=claude with an AGENT_GATEWAY_MODEL_${key} ` +
            `override naming a Claude id instead`,
        });
        model = base.model;
        harness = base.harness;
        variant = base.variant;
        // The max→iu backend switch above was implied by the model that was just reverted —
        // undo it too, or a Max-default route (review, otel, narrative) is left running its
        // default model on metered iu with no fallback.
        const impliedIdx = overrides.findIndex(
          (o) => o.tool === tool && o.field === "backend" && o.implied,
        );
        if (impliedIdx !== -1) {
          overrides.splice(impliedIdx, 1);
          backend = base.backend;
        }
      }
    }
    // `variant` is an opencode-only knob: a route whose harness resolved to `claude` (a
    // default that never had one, or an explicit AGENT_GATEWAY_HARNESS_<TOOL>=claude override
    // paired with a Claude model) must not carry a stale one. Cleared silently, matching
    // the harness-normalization branch above, which drops it as a side effect too.
    if (harness !== "opencode") {
      variant = undefined;
    } else if (variant !== undefined) {
      // A model that does not expose the route's `variant` (a different model's effort ladder)
      // drops it, reported — opencode would otherwise silently fall back to the base options.
      const effective = requireModel(model);
      if (!effective.effort.includes(variant)) {
        overrides.push({
          tool,
          field: "variant",
          value: variant,
          implied: `dropped — ${model} exposes no "${variant}" effort variant`,
        });
        variant = undefined;
      }
    }
    const thinkingOverride = env[`AGENT_GATEWAY_THINKING_TOKENS_${key}`]?.trim();
    if (thinkingOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "thinkingTokens",
          value: thinkingOverride,
          refused: fixedTransportRefusal(
            tool,
            base.transport,
            "the thinking budget only applies to session transport",
          ),
        });
      } else if (harness === "opencode") {
        overrides.push({
          tool,
          field: "thinkingTokens",
          value: thinkingOverride,
          refused: `${tool} runs on the opencode harness — reasoning depth is controlled by AGENT_GATEWAY_VARIANT_${key} instead, not a thinking-token budget`,
        });
      } else {
        const parsed = Number(thinkingOverride);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          overrides.push({
            tool,
            field: "thinkingTokens",
            value: thinkingOverride,
            refused: `expected a positive integer, got "${thinkingOverride}"`,
          });
        } else {
          thinkingTokens = parsed;
          overrides.push({ tool, field: "thinkingTokens", value: thinkingOverride });
        }
      }
    }
    const variantOverride = env[`AGENT_GATEWAY_VARIANT_${key}`]?.trim();
    if (variantOverride) {
      if (base.transport !== "session") {
        overrides.push({
          tool,
          field: "variant",
          value: variantOverride,
          refused: fixedTransportRefusal(tool, base.transport, "a variant override has no effect"),
        });
      } else if (harness === "claude") {
        overrides.push({
          tool,
          field: "variant",
          value: variantOverride,
          refused: `${tool} runs on the claude harness — variant is an opencode-only reasoning-effort knob`,
        });
      } else if (!requireModel(model).effort.includes(variantOverride)) {
        overrides.push({
          tool,
          field: "variant",
          value: variantOverride,
          refused: `${model} exposes no "${variantOverride}" effort variant — declared: ${
            requireModel(model).effort.join(", ") || "none"
          }`,
        });
      } else {
        variant = variantOverride;
        overrides.push({ tool, field: "variant", value: variantOverride });
      }
    }
    routes[tool] = {
      model,
      backend,
      fallback: usableFallback(base.fallback, model, backend),
      transport: base.transport,
      thinkingTokens,
      harness,
      variant,
    };
  }
  return { routes, overrides };
}

/** A fallback is only kept when it actually moves somewhere Max can serve: not the
 *  primary's own backend, and never a gateway id onto `max` without a fixed Claude
 *  fallback model. */
function usableFallback(
  fallback: RouteFallback | null,
  model: string,
  backend: Backend,
): RouteFallback | null {
  if (!fallback || fallback.backend === backend) return null;
  const fallbackModel = fallback.model ?? model;
  if (fallback.backend === "max" && !servesOnMax(fallbackModel)) return null;
  return fallback;
}

/** A default route (or its fixed fallback model) naming an unregistered/unverified id is a
 *  code bug, not an operator typo — fail at module load, not at the first dispatch. */
function assertDefaultRoutesValid(): void {
  for (const tool of ROUTED_TOOLS) {
    const route = DEFAULT_ROUTES[tool];
    for (const id of [route.model, route.fallback?.model]) {
      if (id === undefined) continue;
      const check = validateModel(id, { singleShot: tool === "prose_write" });
      if (!check.ok) throw new Error(`default route "${tool}": ${check.reason}`);
    }
    const entry = requireModel(route.model);
    if (route.transport === "session" && !entry.harnesses.includes(route.harness)) {
      throw new Error(
        `default route "${tool}": ${route.model} cannot run on harness ${route.harness}`,
      );
    }
    if (route.backend === "max" && !entry.backends.includes("max")) {
      throw new Error(`default route "${tool}": ${route.model} cannot be served by max`);
    }
  }
}
assertDefaultRoutesValid();

const TABLE = buildRoutingTable(process.env);

export function routingTable(): RoutingTable {
  return TABLE;
}

/** The registry as served by `GET /api/routing` (`models`). */
export function routingModels(): readonly ModelEntry[] {
  return listModels();
}

/** The effective route for a tool. Always a fresh object — callers may override `model`. */
export function routeFor(tool: RoutedTool): ToolRoute {
  const r = TABLE.routes[tool];
  return {
    model: r.model,
    backend: r.backend,
    fallback: r.fallback ? { ...r.fallback } : null,
    transport: r.transport,
    thinkingTokens: r.thinkingTokens,
    harness: r.harness,
    variant: r.variant,
  };
}

/** The route key for a review angle id (`senior-dev` → `review_angle_senior_dev`), or
 *  `review` for an angle with no key of its own (architect, security, backend, …). */
export function reviewAngleRouteKey(angle: string): RoutedTool {
  const key = `review_angle_${angle.replaceAll("-", "_")}`;
  return (ROUTED_TOOLS as readonly string[]).includes(key) ? (key as RoutedTool) : "review";
}

/** The route a session runs on when an OpenCode harness is unsafe in the cwd (a live checkout
 *  carrying its own `opencode.json`/`.opencode/`: a plugin there executes regardless of the
 *  permission profile). Built from the JUDGE constant — Sonnet on Max over `claude -p` — and
 *  deliberately NOT read from the env-overridable table, so no operator override can point the
 *  fallback back at OpenCode. */
export function claudeSafeRoute(): ToolRoute {
  return { ...JUDGE, fallback: JUDGE.fallback ? { ...JUDGE.fallback } : null };
}

/** The effective route for one review angle session — its own key when it has one, else `review`. */
export function routeForReviewAngle(angle: string): ToolRoute {
  return routeFor(reviewAngleRouteKey(angle));
}

/** A route with a per-call model override (a job's `model` param). The override must pass
 *  the registry (`validateModel`: registered AND verified) and be runnable on a harness; an
 *  id that fails either is REFUSED by returning the route unchanged — `withModel` never
 *  throws, so a caller wanting a loud refusal checks `validateModel(id)` itself at submit.
 *  The backend is kept unless the override cannot be served by Max (a gateway id).
 *
 *  Harness comes from the registry's `harnesses`: the route's own harness is kept when the
 *  model supports it; otherwise a claude-capable id (any Claude id, DeepSeek-V4-Flash)
 *  forces `claude` — opencode's providers have no code path to the Anthropic wire — and an
 *  id with neither is refused. `variant` is dropped once forced onto `claude` or when the
 *  new model does not expose it. Non-session transports (iu-openai, iu-anthropic, external-iu) have no
 *  harness, so theirs is left alone. A `singleShotOnly` id is refused (the route is returned
 *  unchanged): `prose` never goes through here. */
export function withModel(route: ToolRoute, model: string | undefined): ToolRoute {
  if (!model || model === route.model) return route;
  const check = validateModel(model);
  if (!check.ok) return route;
  const entry = check.model;
  let harness: Harness = route.harness;
  if (route.transport === "session" && !entry.harnesses.includes(route.harness)) {
    if (!entry.harnesses.includes("claude")) return route;
    harness = "claude";
  }
  const backend: Backend = route.backend === "max" && !servesOnMax(model) ? "iu" : route.backend;
  // A Claude override also becomes the fallback model (both backends serve it — quality
  // stays constant across the hop, only billing moves); a gateway override keeps a
  // fixed-model fallback (check's Haiku) as declared, since it cannot run on Max itself.
  const declared =
    route.fallback && servesOnMax(model) ? { backend: route.fallback.backend } : route.fallback;
  return {
    model,
    backend,
    fallback: usableFallback(declared, model, backend),
    transport: route.transport,
    // Carried over unchanged: it's a property of the tool's tier, not the model override
    // itself. Harmless when the override moves to a Claude id — buildWorkerEnv only ever
    // exports MAX_THINKING_TOKENS for a non-Claude model.
    thinkingTokens: route.thinkingTokens,
    harness,
    variant: harness === "opencode" ? variantFor(entry, route.variant) : undefined,
  };
}

/** One-line human rendering for tool descriptions and logs: `DeepSeek-V4-Flash on iu (fallback claude-haiku-4-5 on max)`,
 *  or, for an opencode-harness route, `deepseek-v4.1-flash on iu via opencode (variant high) (fallback claude-sonnet-5[1m] on max)`. */
export function describeRoute(route: ToolRoute): string {
  const harnessPart =
    route.harness === "opencode"
      ? ` via opencode${route.variant ? ` (variant ${route.variant})` : ""}`
      : "";
  const fb = route.fallback
    ? ` (fallback ${route.fallback.model ?? route.model} on ${route.fallback.backend})`
    : "";
  return `${route.model} on ${route.backend}${harnessPart}${fb}`;
}

/** Log the effective override list once at startup — `warn` if any override was refused
 *  (a typo'd `.env` entry, most likely), `info` otherwise. No-op when there are no
 *  overrides at all, so a clean install stays quiet. Each entrypoint calls this with its
 *  own logger AFTER `setProcessKind` so the log line is tagged with the right `source`
 *  (routing.ts's own module-load timing runs before an entrypoint's `setProcessKind` call —
 *  see process-context.ts — so this is deliberately NOT called at module load here).
 *
 *  `overrides` defaults to the real module singleton (`TABLE.overrides`) for both real
 *  entrypoints; the param exists so tests can drive all three log branches (none /
 *  refused / applied) without needing a second process to get a different `TABLE` built
 *  from different env. */
export function logRoutingOverrides(
  log: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
  },
  overrides: RoutingOverride[] = TABLE.overrides,
): void {
  if (overrides.length === 0) return;
  const fields = { event: "routing.overrides", overrides };
  if (overrides.some((o) => o.refused)) {
    log.warn(fields, "routing overrides applied at startup (one or more refused)");
  } else {
    log.info(fields, "routing overrides applied at startup");
  }
}

// ── Stale quota env vars ────────────────────────────────────────────────────────────
//
// AGENT_GATEWAY_MAX_QUOTA_CEILING, AGENT_GATEWAY_MAX_WEEKLY_CEILING and
// AGENT_GATEWAY_QUOTA_FILE_MAX_AGE_S fed the proactive Max-quota pre-check removed
// 2026-09-08 (see session-runner.ts's `resolveBackend` doc comment and
// docs/routing-and-quota.md) — a real `.env` still setting one of them now gets a
// silent no-op. `logRoutingOverrides` already surfaces a mistyped
// `AGENT_GATEWAY_MODEL_*`/`AGENT_GATEWAY_BACKEND_*` var the same way; this applies the same
// "warn once at startup" pattern to these three so the owner learns the fallback is
// now purely reactive instead of finding out mid-outage.
const STALE_QUOTA_ENV_VARS = [
  "AGENT_GATEWAY_MAX_QUOTA_CEILING",
  "AGENT_GATEWAY_MAX_WEEKLY_CEILING",
  "AGENT_GATEWAY_QUOTA_FILE_MAX_AGE_S",
] as const;

/** Log once at startup (`warn`) if any of the three retired quota env vars are still set.
 *  No-op otherwise. `env` defaults to `process.env`; overridable for tests. */
export function logStaleQuotaEnvVars(
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
  env: Record<string, string | undefined> = process.env,
): void {
  const set = STALE_QUOTA_ENV_VARS.filter((key) => env[key] !== undefined);
  if (set.length === 0) return;
  log.warn(
    { event: "routing.stale_env", vars: set },
    "quota env var(s) set but no longer read — the proactive Max-quota pre-check was removed " +
      "2026-09-08; the reactive max→iu fallback is now the only safeguard",
  );
}
