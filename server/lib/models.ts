// ── Model registry — the ONE place a model id's capabilities are declared ────────────────
//
// `routing.ts` decides which model a tool runs on; this file decides which model ids may be
// routed to AT ALL and over what wire. Every route (defaults, `SIDECLAW_MODEL_<TOOL>` env
// overrides, per-job `model` overrides) is validated against it, `opencode-runner.ts`
// generates its provider config (limits, cost, variants) from it, and `GET /api/routing`
// exposes it. Pure data + three lookups — no imports, so `routing.ts` and the runner can both
// depend on it without a cycle.
//
// `verified` is the ISO date of probe/measurement evidence carried by this repo (a dated
// routing.ts comment, a test, or a probe recorded below). `null` = declared but never probed:
// routing REFUSES an unverified id, so a registry entry is an allow-list candidate, not an
// allow-list. Promote an id only with evidence, and say what the evidence is in its comment.
//
// `wire` is the transport an agent loop speaks to the id, which decides the harness:
//   anthropic — the IU native Anthropic route (`/anthropic/v1/messages`); what `claude -p` needs
//   chat      — the IU OpenAI-compatible Chat Completions route; opencode's `iu-chat` provider
//   responses — the IU OpenAI Responses route; opencode's `iu-responses` provider. GPT ids are
//               Responses-only for agent loops (reasoning items must survive tool calls).
// A single-shot `textComplete`/`visionRead` call (the `iu-openai` transport) is a different
// path from an agent loop and is NOT what `wire` describes.

export type ModelWire = "anthropic" | "chat" | "responses";
export type ModelHarness = "claude" | "opencode";
export type ModelBackend = "iu" | "max";

export interface ModelEntry {
  id: string;
  /** Display name — opencode's `models.<id>.name`. */
  name: string;
  wire: ModelWire;
  /** Harnesses that can drive this id. A route's (model, harness) pair is valid iff listed. */
  harnesses: readonly ModelHarness[];
  /** Backends that can serve this id: `max` only ever serves a Claude id. */
  backends: readonly ModelBackend[];
  limit: {
    context: number;
    output: number;
    /** Smallest `max_completion_tokens` a single-shot caller should send — reasoning tokens
     *  count against it, and a budget below this truncates before any answer is emitted. */
    minOutput: number;
  };
  /** USD per MTok. `cacheRead` absent → billed at 0.1x `in` (modelpick's convention — a
   *  missing cache rate must never make cached tokens look free). */
  rate: { in: number; out: number; cacheRead?: number; source: string; date: string };
  /** Reasoning-effort variants the id accepts (opencode `--variant`); [] = none exposed. */
  effort: readonly string[];
  /** Whether `response_format: {type: "json_object"}` is probed to work on the chat wire. */
  jsonObject: boolean;
  /** ISO date of probe evidence, or null. */
  verified: string | null;
}

const OC_JSON_SOURCE = "dotfiles config/opencode/opencode.json (declared, never probed)";
const OC_JSON_DATE = "2026-10-02";
const CLAUDE_RATE_SOURCE = "modelpick CLAUDE_LIST_RATES (Anthropic list; cache read 0.1x)";
const CLAUDE_RATE_DATE = "2026-09-13";
const MIN_OUTPUT_REASONING = 16_000;
const MIN_OUTPUT_PLAIN = 4_096;

const MODELS: readonly ModelEntry[] = [
  // ── Claude ids: `claude -p`, served by Max AND the IU Anthropic route ────────────────
  // Verified by being the JUDGE/PROSE/fallback seat in production since 2026-07-07 (first
  // routing.ts use of `claude-sonnet-5[1m]`; Haiku since 2026-04-05, the CLASSIFY fallback).
  {
    id: "claude-sonnet-5[1m]",
    name: "Claude Sonnet 5 (1M)",
    wire: "anthropic",
    harnesses: ["claude"],
    backends: ["iu", "max"],
    limit: { context: 1_000_000, output: 64_000, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 2, out: 10, source: CLAUDE_RATE_SOURCE, date: CLAUDE_RATE_DATE },
    effort: [],
    jsonObject: false,
    verified: "2026-07-07",
  },
  {
    id: "claude-sonnet-5",
    name: "Claude Sonnet 5",
    wire: "anthropic",
    harnesses: ["claude"],
    backends: ["iu", "max"],
    limit: { context: 200_000, output: 64_000, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 2, out: 10, source: CLAUDE_RATE_SOURCE, date: CLAUDE_RATE_DATE },
    effort: [],
    jsonObject: false,
    verified: "2026-07-07",
  },
  {
    id: "claude-haiku-4-5",
    name: "Claude Haiku 4.5",
    wire: "anthropic",
    harnesses: ["claude"],
    backends: ["iu", "max"],
    limit: { context: 200_000, output: 64_000, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 1, out: 5, source: CLAUDE_RATE_SOURCE, date: CLAUDE_RATE_DATE },
    effort: [],
    jsonObject: false,
    verified: "2026-04-05",
  },

  // ── DeepSeek ─────────────────────────────────────────────────────────────────────────
  // DeepSeek-V4-Flash over the IU Anthropic route (`claude -p`): CLASSIFY tier. Verified by
  // modelpick ccbench + the warden POC, 2026-09-20/21 (routing.ts AGENT note); in routing.ts
  // since 2026-06-02. Rate: modelpick probe-solved gateway usage.cost ($0.44/$1.32).
  {
    id: "DeepSeek-V4-Flash",
    name: "DeepSeek V4 Flash",
    wire: "anthropic",
    harnesses: ["claude"],
    backends: ["iu"],
    limit: { context: 1_000_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: {
      in: 0.44,
      out: 1.32,
      source: "modelpick pick_probe (gateway usage.cost, cost.ts comment)",
      date: "2026-09-13",
    },
    effort: [],
    jsonObject: false,
    verified: "2026-09-21",
  },
  // deepseek-v4.1-flash over the OpenAI-compatible route (opencode only — `claude -p` cannot
  // reach it). Verified by the 2026-09-24 three-brief implement measurement (routing.ts
  // AGENT_OC) and the review_ocr bake-off. OPEN FACT: rates conflict — sideclaw's
  // gateway-measured 0.15/0.60/0.003 (kept here; what opencode-runner.ts costs against) vs
  // modelpick's 0.50/1.50. Re-probe before any cost claim. `jsonObject`: probed 2026-10-02 —
  // /chat/completions with response_format json_object + max_completion_tokens 16000 → HTTP 200,
  // valid JSON content.
  {
    id: "deepseek-v4.1-flash",
    name: "DeepSeek V4.1 Flash",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 850_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: {
      in: 0.15,
      out: 0.6,
      cacheRead: 0.003,
      source:
        "sideclaw gateway-measured 2026-09-24 (routing.ts AGENT_OC); CONFLICTS with modelpick 0.50/1.50 per MTok — unresolved, re-probe before cost claims",
      date: "2026-09-24",
    },
    effort: ["high", "max", "none"],
    jsonObject: true,
    verified: "2026-09-24",
  },
  // Probed 2026-10-05 (scripts/probe-implement.ts, opencode harness, variant "max"): two
  // replayed real implement briefs, both passed their reference tests — 8 and 5 turns,
  // 51 s / 70 s, $0.061 / $0.067. The dispatch implement attempt-3+ escalation seat
  // (routing.ts AGENT_OC_ESCALATION); gpt-6.1-sol stays verified-for-Responses only.
  {
    id: "DeepSeek-V4-Pro",
    name: "DeepSeek V4 Pro",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_100_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 0.66, out: 1.98, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["high", "max", "none"],
    jsonObject: false,
    verified: "2026-10-05",
  },

  // ── GLM — retired from every route 2026-09-23; kept only as a documented id. ─────────
  {
    id: "glm-5.3-flash",
    name: "GLM 5.3 Flash",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_100_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 0.075, out: 0.25, cacheRead: 0.03, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["high", "max", "none"],
    jsonObject: false,
    verified: null,
  },

  // ── GPT ids: Responses wire ONLY, opencode `iu-responses` provider ───────────────────
  // gpt-5.6-terra is verified by the adversary route (single-shot Chat Completions via the
  // iu-openai transport, in routing.ts since 2026-07-16) — that is evidence the id is served
  // and answers, NOT of an agent loop over the Responses wire.
  {
    id: "gpt-6.1-sol",
    name: "GPT-6.1 Sol",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 2, out: 10, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    // Probed 2026-10-02: POST {iu openai base}/responses, one function tool `echo`,
    // tool_choice "required" -> HTTP 200, status "completed", output [function_call echo
    // {"text":"ping"}], 50 in / 17 out tokens. One call, not an agent loop.
    verified: "2026-10-02",
  },
  {
    id: "gpt-6-sol",
    name: "GPT-6 Sol",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 2, out: 10, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    verified: null,
  },
  {
    id: "gpt-5.6-sol",
    name: "GPT-5.6 Sol",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 2, out: 10, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    verified: null,
  },
  {
    id: "gpt-5.6-terra",
    name: "GPT-5.6 Terra",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 2, out: 12, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    verified: "2026-07-16",
  },
  {
    id: "gpt-6-luna",
    name: "GPT-6 Luna",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 0.1, out: 0.5, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    verified: null,
  },
  {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    wire: "responses",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_050_000, output: 65_536, minOutput: MIN_OUTPUT_REASONING },
    rate: { in: 10, out: 50, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: ["low", "high", "max"],
    jsonObject: false,
    verified: null,
  },

  // ── Gemini / other chat-wire ids ─────────────────────────────────────────────────────
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_048_576, output: 65_536, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 0.75, out: 3.75, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: [],
    jsonObject: false,
    verified: null,
  },
  // gemini-3.5-flash is verified for VISION only (visionRead over iu-openai chat/completions,
  // in routing.ts since 2026-05-26) — not as an opencode agent loop.
  {
    id: "gemini-3.5-flash",
    name: "Gemini 3.5 Flash",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_048_576, output: 65_536, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 1.5, out: 9, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: [],
    jsonObject: false,
    verified: "2026-05-26",
  },
  {
    id: "kimi-k2.7-code",
    name: "Kimi K2.7 Code",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 262_144, output: 65_536, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 0.95, out: 4, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: [],
    jsonObject: false,
    verified: null,
  },
  {
    id: "minimax-m3",
    name: "MiniMax M3",
    wire: "chat",
    harnesses: ["opencode"],
    backends: ["iu"],
    limit: { context: 1_048_576, output: 65_536, minOutput: MIN_OUTPUT_PLAIN },
    rate: { in: 0.3, out: 1.2, source: OC_JSON_SOURCE, date: OC_JSON_DATE },
    effort: [],
    jsonObject: false,
    verified: null,
  },
];

const BY_ID: ReadonlyMap<string, ModelEntry> = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): ModelEntry | undefined {
  return BY_ID.get(id);
}

/** True only for a registered id carrying probe evidence. */
export function isVerified(id: string): boolean {
  return getModel(id)?.verified != null;
}

export function listModels(): readonly ModelEntry[] {
  return MODELS;
}
