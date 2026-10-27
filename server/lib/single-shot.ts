import { z } from "zod";
import { logger } from "../mcp/logger.ts";
import { getIuConfig, recordIuUsage, textComplete, type IuUsage } from "./iu-openai.ts";
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
//     retried here — `iuFetch` already retries those, and a second pass would only double-bill;
//   - a cancel requested while attempt 1 was in flight stops the retry (`isCancelled`), so a
//     cancelled job does not bill a second completion.
// Usage is recorded per attempt by `textComplete` itself (`recordIuUsage`, tagged with `tool`).

const MIN_MAX_COMPLETION_TOKENS = 16_000;
const MAX_ATTEMPTS = 2;
/** How much of the rejected answer is echoed back on the retry — enough to repair, bounded so a
 *  runaway answer cannot double the prompt. */
const RETRY_ECHO_CHARS = 4_000;

/** The cancel marker: thrown before a retry when the caller's `isCancelled` reports a cancel,
 *  so the retry loop stops instead of spending another completion. Nothing branches on the
 *  type — `store.ts`'s `execute()` classifies `cancelled` vs `failed` from the job row's cancel
 *  request, not from this error — it only lets a direct caller tell the two apart. */
export class SingleShotCancelledError extends Error {
  constructor(tool: string) {
    super(`${tool}: cancelled by request before the retry`);
    this.name = "SingleShotCancelledError";
  }
}

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
  /** Polled before each retry attempt (never before the first); true aborts with
   *  `SingleShotCancelledError`. */
  isCancelled?: () => boolean;
  /** Forwarded to `recordIuUsage` on every attempt — see its own fields for when to pass these. */
  jobId?: string;
  cwd?: string;
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
    if (attempt >= 2 && opts.isCancelled?.()) throw new SingleShotCancelledError(tool);
    const result = await textComplete({
      prompt,
      model: route.model,
      tool,
      maxTokens,
      jsonObject,
      jobId: opts.jobId,
      cwd: opts.cwd,
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
    if (attempt < MAX_ATTEMPTS) prompt = retryPrompt(opts.prompt, result.text, reason);
  }

  throw new Error(`${tool}: model output rejected after ${MAX_ATTEMPTS} attempts — ${lastReason}`);
}

// ── Anthropic-wire single-shot — the native Messages sibling of `textComplete` ────────────
//
// `textComplete` speaks the OpenAI chat wire, so an anthropic-wire id (registry `wire:
// "anthropic"`) cannot be called through it. This is the smallest sibling: one POST to the IU
// native Messages route (`<anthropicBase>/v1/messages`, the same base and bearer key the Claude
// CLI is handed in session-runner.ts), with a system prompt, one user turn and extended
// adaptive thinking. Free text out, not JSON — the caller owns any structure.
//   - Non-streaming under a 30 min hang guard: a client that cannot stream falls back to the
//     hard cap the agent-limits rule allows (`AbortSignal.timeout`), never an unbounded wait.
//   - Thinking is `{ type: "adaptive" }` with `output_config: { effort: "high" }`: the newer
//     Claude ids (opus-5-5) reject `thinking.type.enabled` with a 400, and adaptive is accepted
//     by both generations (modelpick `bench:writing`, 6/6 each). `max_tokens` is 32000:
//     reasoning tokens count against it, so a smaller total truncates before any answer.
//   - `stop_reason: "max_tokens"` is never a success. EMPTY text is the starved case — a 200 with
//     no answer, the thinking having eaten the whole allowance (`AnthropicStarvedError`); text that
//     stops mid-answer is `AnthropicTruncatedError`. Both, and a stop with no text at all, are
//     `AnthropicContentError`s: the call worked, the content is unusable.
//   - a cancel requested while an attempt was in flight stops the next retry (`isCancelled`,
//     `SingleShotCancelledError`), so a cancelled job does not bill another long call;
//   - 429/5xx and connection errors retry (0.5s, 1.5s, 4.5s); 410 and other 4xx fail fast. A hang
//     guard timeout (`TimeoutError`/`AbortError`) is NOT retried: it already waited 30 min, and
//     three of those would hold a job for 90. IU wraps an upstream 400 as a 503, so a body naming
//     `invalid_request_error` is a deterministic client error and also fails fast. Usage is
//     recorded on every path, including failure, because a paid call bills tokens even when it
//     returns no text.

const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_MAX_TOKENS = 32_000;
const ANTHROPIC_HANG_GUARD_MS = 30 * 60 * 1000;
const ANTHROPIC_ATTEMPTS = 3;
const ANTHROPIC_RETRYABLE = new Set([429, 500, 502, 503, 504]);

/** The call succeeded but its content is unusable (starved, truncated, empty). Callers that can
 *  fall back to what they had catch this class; every other error is a transport/infra failure.
 *  The call was billed, so `usage` and `stopReason` ride along for the caller to report. */
export class AnthropicContentError extends Error {
  usage?: IuUsage;
  stopReason?: string | null;
  constructor(message: string) {
    super(message);
    this.name = "AnthropicContentError";
  }
}

export class AnthropicStarvedError extends AnthropicContentError {
  constructor(tool: string, model: string) {
    super(`${tool}: ${model} produced no text before max_tokens — the thinking starved the answer`);
    this.name = "AnthropicStarvedError";
  }
}

export class AnthropicTruncatedError extends AnthropicContentError {
  constructor(tool: string, model: string) {
    super(`${tool}: ${model} output truncated at max_tokens — the answer is incomplete`);
    this.name = "AnthropicTruncatedError";
  }
}

const USAGE_SCHEMA = z.object({
  input_tokens: z.number().nullish(),
  output_tokens: z.number().nullish(),
  cache_read_input_tokens: z.number().nullish(),
  cache_creation_input_tokens: z.number().nullish(),
});

const MESSAGE_SCHEMA = z.object({
  id: z.string().nullish(),
  model: z.string().nullish(),
  stop_reason: z.string().nullish(),
  content: z.array(z.object({ type: z.string(), text: z.string().nullish() })),
  usage: USAGE_SCHEMA.nullish(),
});

type AnthropicMessage = z.infer<typeof MESSAGE_SCHEMA>;
type AnthropicUsage = z.infer<typeof USAGE_SCHEMA>;

/** The Messages request this module sends. */
interface MessagesRequest {
  model: string;
  max_tokens: number;
  thinking: { type: "adaptive" };
  output_config: { effort: "high" };
  messages: { role: "user"; content: string }[];
  system?: string;
}

export interface AnthropicCompleteResult {
  text: string;
  model: string;
  latencyMs: number;
  usage?: IuUsage;
}

/** One POST attempt: the response, or the transport error that prevented one. */
async function sendMessage(url: string, key: string, body: string): Promise<Response | Error> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body,
      signal: AbortSignal.timeout(ANTHROPIC_HANG_GUARD_MS),
    });
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** 429/5xx, except a body that names `invalid_request_error` — a client error IU wrapped. */
const isRetryable = (status: number, detail: string) =>
  ANTHROPIC_RETRYABLE.has(status) && !detail.includes("invalid_request_error");

const backoff = (attempt: number) => Bun.sleep(500 * 3 ** attempt);

/** The hang guard fired (`AbortSignal.timeout`): the wait is already spent, so it is not retried. */
const isHangGuard = (err: Error) => err.name === "TimeoutError" || err.name === "AbortError";

function toIuUsage(u: AnthropicUsage | null | undefined): IuUsage {
  const cacheRead = u?.cache_read_input_tokens ?? 0;
  const inputTokens = (u?.input_tokens ?? 0) + cacheRead + (u?.cache_creation_input_tokens ?? 0);
  const outputTokens = u?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    reasoningTokens: 0,
    totalTokens: inputTokens + outputTokens,
    cacheReadTokens: cacheRead,
    costUsd: null,
  };
}

/** Record one Messages call's usage row. `ok` only for a call whose content was used. */
function recordAnthropicUsage(
  ctx: { tool: string; model: string; jobId?: string; cwd?: string },
  data: { id?: string | null; usage?: AnthropicUsage | null },
  latencyMs: number,
  outcome: "ok" | "error",
): Promise<void> {
  return recordIuUsage({
    tool: ctx.tool,
    model: ctx.model,
    usage: toIuUsage(data.usage),
    requestId: data.id ?? undefined,
    latencyMs,
    cacheWriteTokens: data.usage?.cache_creation_input_tokens ?? 0,
    outcome,
    jobId: ctx.jobId,
    cwd: ctx.cwd,
  });
}

/** Parse a 200 body. A body that fails the schema still billed tokens, so its `usage` is recorded
 *  on a best-effort basis before the parse error is thrown. */
async function parseMessage(
  res: Response,
  ctx: { tool: string; model: string; jobId?: string; cwd?: string },
  t0: number,
): Promise<AnthropicMessage> {
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    // A 200 whose body is not JSON carries no usage to read; the row still marks the failed call.
    await recordAnthropicUsage(ctx, {}, Math.round(performance.now() - t0), "error");
    throw new Error(`${ctx.tool}: ${ctx.model} returned an unreadable Messages body — not JSON`);
  }
  const parsed = MESSAGE_SCHEMA.safeParse(json);
  if (parsed.success) return parsed.data;
  const raw = json as { id?: unknown; usage?: unknown } | null;
  const usage = USAGE_SCHEMA.nullish().safeParse(raw?.usage);
  await recordAnthropicUsage(
    ctx,
    { id: typeof raw?.id === "string" ? raw.id : null, usage: usage.success ? usage.data : null },
    Math.round(performance.now() - t0),
    "error",
  );
  throw new Error(
    `${ctx.tool}: ${ctx.model} returned an unreadable Messages body — ${parsed.error.message}`,
  );
}

/** One attempt's outcome: the parsed message, or the error to throw and whether another attempt
 *  could fix it. */
type Attempt = { message: AnthropicMessage } | { error: Error; retryable: boolean };

/** A non-2xx response as a failed attempt. */
async function failedAttempt(res: Response): Promise<Attempt> {
  const detail = await res.text().catch(() => "");
  if (res.status === 410) {
    return {
      retryable: false,
      error: new Error(`Model deprecated (410). Detail: ${detail.slice(0, 200)}`),
    };
  }
  return {
    retryable: isRetryable(res.status, detail),
    error: new Error(`IU anthropic request failed (${res.status}): ${detail.slice(0, 300)}`),
  };
}

async function attemptMessage(
  call: { url: string; key: string; payload: string },
  ctx: { tool: string; model: string },
  t0: number,
): Promise<Attempt> {
  const res = await sendMessage(call.url, call.key, call.payload);
  if (res instanceof Error) return { error: res, retryable: !isHangGuard(res) };
  if (res.ok) return { message: await parseMessage(res, ctx, t0) };
  return failedAttempt(res);
}

async function postMessage(
  body: MessagesRequest,
  ctx: { tool: string; model: string },
  t0: number,
  isCancelled?: () => boolean,
): Promise<AnthropicMessage> {
  const { key, anthropicBase } = await getIuConfig();
  const call = {
    url: `${anthropicBase.replace(/\/+$/, "")}/v1/messages`,
    key,
    payload: JSON.stringify(body),
  };
  for (let i = 0; ; i++) {
    if (i > 0 && isCancelled?.()) throw new SingleShotCancelledError(ctx.tool);
    const attempt = await attemptMessage(call, ctx, t0);
    if ("message" in attempt) return attempt.message;
    if (i === ANTHROPIC_ATTEMPTS - 1 || !attempt.retryable) throw attempt.error;
    await backoff(i);
  }
}

/** The stop reasons that mean the model finished its answer; anything else (refusal, max_tokens,
 *  pause_turn, null …) is not a complete answer, whatever text came with it. */
const COMPLETE_STOP_REASONS = new Set(["end_turn", "stop_sequence"]);

/** The error for an unusable answer, or null when `text` can be used. */
function contentFailure(
  ctx: { tool: string; model: string },
  stopReason: string | null | undefined,
  text: string,
): AnthropicContentError | null {
  const truncated = stopReason === "max_tokens";
  if (!text && truncated) return new AnthropicStarvedError(ctx.tool, ctx.model);
  if (!text) {
    return new AnthropicContentError(
      `${ctx.tool}: ${ctx.model} returned no text (stop_reason ${stopReason ?? "none"})`,
    );
  }
  if (truncated) return new AnthropicTruncatedError(ctx.tool, ctx.model);
  if (stopReason && COMPLETE_STOP_REASONS.has(stopReason)) return null;
  return new AnthropicContentError(
    `${ctx.tool}: ${ctx.model} ended with stop_reason ${stopReason ?? "none"} — the answer is not complete`,
  );
}

/** One non-streaming Messages call for an anthropic-wire id. `tool` tags the usage row. */
export async function anthropicComplete(opts: {
  tool: string;
  model: string;
  system?: string;
  prompt: string;
  /** Polled before each retry attempt (never before the first); true aborts with
   *  `SingleShotCancelledError`. */
  isCancelled?: () => boolean;
  /** Forwarded to `recordIuUsage` — see its own fields for when to pass these. */
  jobId?: string;
  cwd?: string;
}): Promise<AnthropicCompleteResult> {
  if (getModel(opts.model)?.wire !== "anthropic") {
    throw new Error(`${opts.tool}: ${opts.model} is not an anthropic-wire model`);
  }
  const body: MessagesRequest = {
    model: opts.model,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    messages: [{ role: "user", content: opts.prompt }],
  };
  if (opts.system) body.system = opts.system;

  const ctx = { tool: opts.tool, model: opts.model, jobId: opts.jobId, cwd: opts.cwd };
  const t0 = performance.now();
  const data = await postMessage(body, ctx, t0, opts.isCancelled);
  const latencyMs = Math.round(performance.now() - t0);

  const usage = toIuUsage(data.usage);
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();
  const failure = contentFailure(ctx, data.stop_reason, text);

  await recordAnthropicUsage(ctx, data, latencyMs, failure ? "error" : "ok");
  if (failure) {
    failure.usage = usage;
    failure.stopReason = data.stop_reason;
    throw failure;
  }
  return { text, model: data.model ?? opts.model, latencyMs, usage };
}
