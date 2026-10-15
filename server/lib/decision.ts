import { experimental_decide as decide } from "ai";
import { createTypeSafeAi } from "@ai-sdk/typesafe-ai";
import { z } from "zod";
import { getIuConfig, recordIuUsage } from "./iu-openai.ts";
import { logger } from "../mcp/logger.ts";

// ── Decision models — typed answers with calibrated probabilities, no text generation ─────────
//
// IU's decision API (`<origin>/decisions/v1/systemone`) through the AI SDK's experimental
// `decide` and the official `@ai-sdk/typesafe-ai` provider, mirroring email-gateway's Jev lane
// (`src/llm/jev.ts`). The model cannot search or read anything: the caller's `state` text is its
// whole world, so context quality decides everything. Models come from `GET /decisions/v1/models`;
// only the ones measured here carry a rate. Usage lands in the same `agent-gateway-iu` sink as
// every other IU call (tool `decide`), cost computed from the rate (the provider drops IU's own).

interface DecisionModelInfo {
  /** USD per 1M tokens. The UE price list: decision-1 bills input only. */
  rate: { input: number; output: number };
  /** Hard cap on the state text. Workers AI Clef truncates silently at ~2K tokens; the others'
   *  limits are unmeasured, so this is a conservative ceiling that the shadow replay can raise. */
  maxStateChars: number;
}

export const DECISION_MODELS: Record<string, DecisionModelInfo> = {
  "pplx-decider-v1-27b": { rate: { input: 0.04, output: 0.04 }, maxStateChars: 60_000 },
  "decision-1": { rate: { input: 0.042, output: 0 }, maxStateChars: 60_000 },
  "decision-1-eu": { rate: { input: 0.042, output: 0 }, maxStateChars: 60_000 },
  clef: { rate: { input: 0, output: 0 }, maxStateChars: 6_000 },
  "clef-eu": { rate: { input: 0, output: 0 }, maxStateChars: 6_000 },
  "clef-flash": { rate: { input: 0, output: 0 }, maxStateChars: 6_000 },
};

export const DEFAULT_DECISION_MODEL = "pplx-decider-v1-27b";

export function defaultDecisionModel(): string {
  const override = process.env.AGENT_GATEWAY_DECISION_MODEL;
  return override && override in DECISION_MODELS ? override : DEFAULT_DECISION_MODEL;
}

const HANG_GUARD_MS = 30 * 60_000;

export const DECISION_QUESTION = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(1),
    options: z
      .record(z.string(), z.string().nullable())
      .refine((o) => Object.keys(o).length >= 2, { message: "a choice needs at least two options" })
      .describe("option id → description"),
  }),
  z.object({ type: z.literal("boolean"), instructions: z.string().min(1) }),
]);
export type DecisionQuestion = z.infer<typeof DECISION_QUESTION>;

export type DecisionAnswerOut =
  | { type: "choice"; choice: string; confidence: number; probabilities?: Record<string, number> }
  | { type: "boolean"; value: boolean; confidence: number; probability: number }
  | { type: "refusal" };

export interface DecisionOutput {
  answers: Record<string, DecisionAnswerOut>;
  model: string;
  latencyMs: number;
  usage: { inputTokens: number; outputTokens: number; costUsd: number | null };
  /** State characters cut to fit the model's cap (0 = nothing cut). */
  truncatedChars: number;
}

const metaSchema = z.object({
  confidence: z
    .record(z.string(), z.number().min(0).max(1).optional().catch(undefined))
    .optional()
    .catch(undefined),
});

/** `https://host/anthropic` → `https://host/decisions/v1`. */
async function decisionsBase(): Promise<{ baseURL: string; key: string }> {
  const cfg = await getIuConfig();
  return { baseURL: `${new URL(cfg.openaiBase).origin}/decisions/v1`, key: cfg.key };
}

export async function runDecision(opts: {
  state: string;
  questions: Record<string, DecisionQuestion>;
  model?: string;
}): Promise<DecisionOutput> {
  const model = opts.model ?? defaultDecisionModel();
  const info = DECISION_MODELS[model];
  if (!info)
    throw new Error(
      `unknown decision model "${model}" (known: ${Object.keys(DECISION_MODELS).join(", ")})`,
    );

  const truncatedChars = Math.max(0, opts.state.length - info.maxStateChars);
  const text = truncatedChars > 0 ? opts.state.slice(0, info.maxStateChars) : opts.state;
  const questions = Object.fromEntries(
    Object.entries(opts.questions).map(([id, q]) => [
      id,
      q.type === "choice"
        ? { type: "choice" as const, instructions: q.instructions, criteria: q.options }
        : { type: "boolean" as const, instructions: q.instructions },
    ]),
  );

  const { baseURL, key } = await decisionsBase();
  const startedAt = Date.now();
  let result: Awaited<ReturnType<typeof decide>>;
  try {
    result = await decide({
      model: createTypeSafeAi({ baseURL, apiKey: key }).decisionModel(model),
      state: [{ type: "text", text }],
      questions,
      // The caller (warden) owns retries; one HTTP request per job attempt.
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(HANG_GUARD_MS),
    });
  } catch (err) {
    await recordIuUsage({
      tool: "decide",
      model,
      latencyMs: Date.now() - startedAt,
      outcome: "error",
    });
    throw err;
  }

  const meta = metaSchema.safeParse(result.providerMetadata?.typesafe);
  const confidences = meta.success ? (meta.data.confidence ?? {}) : {};
  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const costUsd = (inputTokens * info.rate.input + outputTokens * info.rate.output) / 1_000_000;
  const latencyMs = Date.now() - startedAt;

  const answers: Record<string, DecisionAnswerOut> = {};
  for (const [id, answer] of Object.entries(result.answers)) {
    if (answer.type === "choice") {
      const confidence = confidences[id] ?? answer.probabilities?.[answer.choice];
      if (confidence === undefined)
        throw new Error(`decision model returned no confidence for "${id}"`);
      answers[id] = {
        type: "choice",
        choice: answer.choice,
        confidence,
        probabilities: answer.probabilities,
      };
    } else if (answer.type === "boolean") {
      answers[id] = {
        type: "boolean",
        value: answer.probability >= 0.5,
        confidence: Math.max(answer.probability, 1 - answer.probability),
        probability: answer.probability,
      };
    } else {
      answers[id] = { type: "refusal" };
    }
  }

  await recordIuUsage({
    tool: "decide",
    model,
    latencyMs,
    usage: {
      inputTokens,
      outputTokens,
      reasoningTokens: 0,
      totalTokens: inputTokens + outputTokens,
      cacheReadTokens: 0,
      costUsd,
    },
  });
  logger.info(
    {
      event: "decide.done",
      tool: "decide",
      model,
      latencyMs,
      inputTokens,
      outputTokens,
      truncatedChars,
    },
    "decide done",
  );
  return {
    answers,
    model,
    latencyMs,
    usage: { inputTokens, outputTokens, costUsd },
    truncatedChars,
  };
}
