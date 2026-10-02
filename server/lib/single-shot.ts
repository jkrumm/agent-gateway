import type { z } from "zod";
import { logger } from "../mcp/logger.ts";
import { textComplete, type IuUsage } from "./iu-openai.ts";
import { getModel } from "./models.ts";
import type { ToolRoute } from "./routing.ts";

// ── Single-shot JSON completion — the no-tools, no-worker-session job shape ───────────────
//
// `triage` and review's angle router need one structured answer from one prompt. A `claude -p`
// / opencode session around that is pure overhead (a process, a worktree-less cwd, a tool loop
// that is never used), so they run as ONE `textComplete` over the IU OpenAI transport instead
// (route `transport: "iu-openai"`, routing.ts SINGLE_SHOT). The caller owns the schema; this
// owns the wire facts and the failure policy:
//   - `response_format: {type: "json_object"}` only when the registry says the model supports
//     it (`ModelEntry.jsonObject`) — JSON mode guarantees valid JSON, never the schema;
//   - `max_completion_tokens` ≥ 16000 and ≥ the registry's `minOutput` — reasoning tokens count
//     against it, a smaller budget truncates before any answer is emitted;
//   - tolerant parse (a ```json fence or stray prose around the object is accepted), then zod
//     validation;
//   - ONE retry with the rejection reason appended, then a throw. A transport failure is NOT
//     retried here — `iuFetch` already retries those, and a second pass would only double-bill.
// Usage is recorded per attempt by `textComplete` itself (`recordIuUsage`, tagged with `tool`).

const MIN_MAX_COMPLETION_TOKENS = 16_000;
const MAX_ATTEMPTS = 2;
/** How much of the rejected answer is echoed back on the retry — enough to repair, bounded so a
 *  runaway answer cannot double the prompt. */
const RETRY_ECHO_CHARS = 4_000;

export interface SingleShotResult<T> {
  data: T;
  model: string;
  /** Summed over every attempt. */
  latencyMs: number;
  /** Summed over every attempt; absent when the gateway reported none. */
  usage?: IuUsage;
  /** 1 on a first-try success, 2 after the retry. */
  attempts: number;
}

/** Best-effort JSON extraction from a model response: strips ```json fences, trims, slices
 *  from the first `{` to the last `}` if prose surrounds the object, and parses. Returns null
 *  on any failure — the caller decides what that means. */
export function parseJsonLoose(raw: string): unknown {
  let s = raw.trim();
  // Strip ```json ... ``` or ``` ... ``` fences if the model added them
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fence) s = fence[1].trim();
  // If there's still extraneous prose, slice from first { to last }
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first >= 0 && last > first) s = s.slice(first, last + 1);
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function addUsage(a: IuUsage | undefined, b: IuUsage | undefined): IuUsage | undefined {
  if (!a || !b) return a ?? b;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    reasoningTokens: a.reasoningTokens + b.reasoningTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    costUsd: a.costUsd === null && b.costUsd === null ? null : (a.costUsd ?? 0) + (b.costUsd ?? 0),
  };
}

function retryPrompt(prompt: string, rejectedText: string, reason: string): string {
  return (
    `${prompt}\n\n` +
    `────────────────────────────────────────────────────────\n` +
    `RETRY — your previous response was REJECTED: ${reason}\n\n` +
    `Previous response (truncated):\n${rejectedText.slice(0, RETRY_ECHO_CHARS)}\n\n` +
    `Return ONLY the corrected JSON object. Your entire message must be a single JSON object — ` +
    `no preamble, no commentary before or after.`
  );
}

/** One tool-less completion that must come back as JSON conforming to `schema`. Throws when the
 *  answer is still unparseable / non-conforming after the single retry, or when the transport
 *  fails. `route.model` is used as-is (it already passed the registry in routing.ts); `route`
 *  is the whole route only so a caller cannot forget which tool's model it is running on. */
export async function singleShotJson<T>(opts: {
  tool: string;
  prompt: string;
  schema: z.ZodType<T>;
  route: ToolRoute;
}): Promise<SingleShotResult<T>> {
  const { tool, schema, route } = opts;
  const entry = getModel(route.model);
  const maxTokens = Math.max(MIN_MAX_COMPLETION_TOKENS, entry?.limit.minOutput ?? 0);
  const jsonObject = entry?.jsonObject === true;

  let prompt = opts.prompt;
  let latencyMs = 0;
  let usage: IuUsage | undefined;
  let lastReason = "";

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const result = await textComplete({
      prompt,
      model: route.model,
      tool,
      maxTokens,
      jsonObject,
    });
    latencyMs += result.latencyMs;
    usage = addUsage(usage, result.usage);

    const parsed = parseJsonLoose(result.text);
    let reason: string;
    if (parsed === null) {
      reason = "the response was not a valid JSON object";
    } else {
      const checked = schema.safeParse(parsed);
      if (checked.success) {
        return { data: checked.data, model: result.model, latencyMs, usage, attempts: attempt };
      }
      reason =
        "the JSON did not conform to the schema: " +
        checked.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    }

    lastReason = reason;
    logger.warn(
      { event: "single_shot.rejected", tool, model: route.model, attempt, reason },
      `${tool} single-shot answer rejected`,
    );
    prompt = retryPrompt(opts.prompt, result.text, reason);
  }

  throw new Error(`${tool}: model output rejected after ${MAX_ATTEMPTS} attempts — ${lastReason}`);
}
