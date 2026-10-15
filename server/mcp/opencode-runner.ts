// ── OpenCode harness — the second worker engine ─────────────────────────────────────
//
// `dispatch`/`dispatch_implement` (AGENT_OC/AGENT_OC_IMPLEMENT, server/lib/routing.ts) run on
// OpenCode instead of `claude -p` — see routing.ts's module-header Harness paragraph for why.
// Since Wave 3 (docs/opencode-v2.md) an episode is a SESSION on the one agw-owned OpenCode v2
// server (opencode-server.ts), driven over HTTP through the `OpencodeClient` port
// (opencode-client.ts): create → environment → prompt → wait → messages. There is no child
// process and no CLI fallback path. This module owns the drive loop (`driveOpencodeSession`),
// the pure message summarizer (`summarizeOpencodeMessages` — tokens, cost, final text and the
// outcome all come from the server's message records, so there is no lost final turn), the IU
// endpoint preflight and one attempt runner (`runOpencodeAttempt`), invoked from
// `session-runner.ts`'s `runSessionAttempt` whenever `resolveHarness()` resolves to
// `"opencode"`. It returns the exact same `SessionResult<T>` shape the claude path does, so
// `runSession`'s retry/fallback loop (`planNextAttempt`), `POST /api/jobs/:id/cancel`
// (`terminateSessionsForJob`, via `trackExternalSession`), the idle watchdog, and
// `onActivity`/`onProgress`/`onSessionId` all keep working unmodified — this module is a second
// engine under the same chassis, not a parallel pipeline.
//
// Supports any model in the registry (`server/lib/models.ts`) whose `harnesses` include
// `opencode`: `runOpencodeAttempt` refuses an unregistered or non-opencode id outright. The
// registry's `wire` picks the provider (`iu-chat`/`iu-responses`) — GPT ids ride Responses only.
//
// Per-session policy: the permission profile is the `agent` on session create; the shell env is
// `PUT /api/session/{id}/environment` — `extraEnv`, the git credential deny, and a BLANK value
// for each server-process credential (`OPENCODE_SESSION_BLANKED_ENV`) so a worker's shell cannot
// read the server's password or the IU key. An unreachable or wrong-version server fails the
// attempt before a session exists, as a transport-class failure.

import { randomUUID } from "node:crypto";
import { GIT_DENY_CREDENTIALS_ENV } from "../jobs/handlers/dispatch-git.ts";
import { getIuConfig } from "../lib/iu-openai.ts";
import { getModel, type ModelEntry } from "../lib/models.ts";
import type { Backend } from "../lib/routing.ts";
import { IDLE_TIMEOUT_MS } from "../lib/idle-timeout.ts";
import {
  extractJson,
  isIdleTimedOut,
  runnerLogger,
  SessionCancelledError,
  SessionDetachedError,
  trackExternalSession,
  unclassifiedOutputFailure,
  writeAttribution,
  writeSessionEnv,
  type SessionOptions,
  type SessionProgress,
  type SessionResult,
} from "./session-runner.ts";
import {
  createOpencodeClient,
  type OpencodeClient,
  type OpencodeMessage,
} from "./opencode-client.ts";
import {
  getOpencodeServerStatus,
  OPENCODE_AGENT_IMPLEMENT,
  OPENCODE_AGENT_READONLY,
  OPENCODE_AGENT_READONLY_SENSITIVE,
  OPENCODE_SESSION_BLANKED_ENV,
  opencodeProviderForWire,
  readServerPassword,
  type OpencodeServerStatus,
} from "./opencode-server.ts";

// ── Named constants (no magic numbers) ──────────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;
/** How often the liveness probe reads the newest messages while a `wait` long-poll is open. */
const ACTIVITY_POLL_MS = 3_000;
/** `wait` can return before a freshly admitted prompt has started its turn; re-check after this. */
const NOT_FINISHED_RECHECK_MS = 250;
const ACTIVITY_WINDOW = 10;
/** Reachability-probe budget before any session is created — see `preflightIuEndpoint`.
 *  Override: `AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS` (read per call, so no reload for a test). */
const DEFAULT_PREFLIGHT_MS = 5_000;

// ── Pure helpers ────────────────────────────────────────────────────────────────────

/** The registry entry for a model this harness can drive, or a thrown refusal: unregistered,
 *  or no `opencode` in its `harnesses` (the Max-served Claude ids, which only `claude -p`
 *  reaches). */
export function opencodeModel(model: string): ModelEntry {
  const entry = getModel(model);
  if (!entry) {
    throw new Error(`opencode harness: unknown model "${model}" — not in the registry`);
  }
  if (!entry.harnesses.includes("opencode")) {
    throw new Error(`opencode harness: model "${model}" is not usable on the opencode harness`);
  }
  return entry;
}

/** Appended to the prompt when `SessionOptions.jsonSchema` is set — opencode has no
 *  `--json-schema` flag (unlike claude), so the schema has to be communicated in-band and the
 *  final assistant TEXT is what gets run through `extractJson` afterward, exactly like
 *  claude's own `result`-field-empty recovery path. */
export function appendJsonSchemaInstruction(
  prompt: string,
  jsonSchema: Record<string, unknown>,
): string {
  return (
    `${prompt}\n\n` +
    "────────────────────────────────────────────────────────\n" +
    "Your FINAL message must be ONLY a single JSON object — no prose before or after, no " +
    "markdown fence commentary, and never a tool call as the last message — matching exactly " +
    "this JSON Schema:\n\n" +
    `${JSON.stringify(jsonSchema, null, 2)}\n`
  );
}

/** Replace every occurrence of `secret` in `text` with a fixed placeholder. `secret` empty →
 *  no-op (never redact against an empty string, which would otherwise match everywhere).
 *  Used to strip the runtime IU key out of anything opencode's own event stream could echo
 *  back — a worker with Bash access can run `env`/`printenv` and the key is a env var in its
 *  process, so `lastAssistantText` (and anything derived from it: `rawText`, a salvaged
 *  `data`) is untrusted output until this runs. */
export function redactSecret(text: string, secret: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

/** Fires exactly once per attempt, the instant the OpenCode session id exists — mirrors the
 *  claude path's `maybeWriteSessionEnv`/`onSessionId` pairing. */
function announceOpencodeSessionId(
  sessionId: string,
  ctx: {
    iuOpenaiBase: string;
    model: string;
    backend: Backend;
    tool: string | undefined;
    onSessionId?: (sessionId: string) => void;
  },
): void {
  writeSessionEnv(sessionId, ctx.iuOpenaiBase, ctx.model, ctx.backend, ctx.tool, "opencode");
  try {
    ctx.onSessionId?.(sessionId);
  } catch {
    /* fire-and-forget, same contract as claude path */
  }
}

// ── Message summary ───────────────────────────────────────────────────────────────────
//
// Everything an attempt reports comes from the server's message records (measured on 2.0.25,
// docs/opencode-v2.md): each `assistant` message carries `tokens`, `cost` (USD, from the config's
// registry rates) and `content` (`text` | `reasoning` | `tool` blocks); the session ends with an
// `idle` message whose `outcome` is `succeeded | failed | interrupted`. A turn that ends in a tool
// call has its own message, so no final-turn usage is lost.

export interface OpencodeSummary {
  /** Assistant messages that finished (carry `tokens`). */
  turns: number;
  lastAction: string;
  /** The newest non-empty assistant text block — narration when the loop did not finish. */
  lastAssistantText: string;
  /** True while the newest content block of the newest assistant message is `text`. A stream cut
   *  off mid-loop ends on a tool block, so its `lastAssistantText` is narration, not a verdict. */
  endedOnText: boolean;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of the per-message `cost` (the settled session rollup is slightly higher). */
  costUsd: number;
  /** The newest assistant message's `error`, as text. */
  errorMessage?: string;
  /** The newest `idle` message's outcome; absent while the session has not gone idle. */
  outcome?: "succeeded" | "failed" | "interrupted";
}

/** Compact human label for a tool block, mirroring `describeTool` in session-runner.ts. */
function describeOpencodeTool(block: {
  name?: string;
  state?: { input?: Record<string, unknown> };
}): string {
  const tool = block.name ?? "tool";
  const input = block.state?.input ?? {};
  if ((tool === "bash" || tool === "shell") && typeof input.command === "string") {
    return `${tool}: ${input.command.slice(0, 50)}`;
  }
  const path = input.filePath ?? input.path;
  if (typeof path === "string") return `${tool} ${path.split("/").pop()}`;
  return tool;
}

/** The newest tool block's label across assistant messages given NEWEST FIRST. */
function lastToolAction(newestFirst: OpencodeMessage[]): string | undefined {
  for (const message of newestFirst) {
    if (message.type !== "assistant") continue;
    const tool = (message.content ?? []).findLast((block) => block.type === "tool");
    if (tool) return describeOpencodeTool(tool);
  }
  return undefined;
}

/** One assistant message's cost. OpenCode prices a message at the model's flat config rates, so a
 *  model with a long-context tier (`rate.longContext`) is repriced from the message's own tokens
 *  once ITS prompt crosses the threshold — the surcharge is per request, not per session. */
function messageCostUsd(message: OpencodeMessage, model: ModelEntry | undefined): number {
  const tier = model?.rate.longContext;
  const tokens = message.tokens;
  if (!tier || !tokens) return message.cost ?? 0;
  const input = tokens.input ?? 0;
  const cacheRead = tokens.cache?.read ?? 0;
  const cacheWrite = tokens.cache?.write ?? 0;
  if (input + cacheRead + cacheWrite <= tier.above) return message.cost ?? 0;
  const out = (tokens.output ?? 0) + (tokens.reasoning ?? 0);
  return (
    (input * tier.in + cacheRead * tier.cacheRead + cacheWrite * tier.cacheWrite + out * tier.out) /
    1_000_000
  );
}

/** Pure fold over a session's messages, OLDEST FIRST (`OpencodeClient.allMessages`). `model`
 *  enables the long-context repricing in `messageCostUsd`. */
export function summarizeOpencodeMessages(
  messages: OpencodeMessage[],
  model?: ModelEntry,
): OpencodeSummary {
  const summary: OpencodeSummary = {
    turns: 0,
    lastAction: "starting",
    lastAssistantText: "",
    endedOnText: false,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
  let newestAssistant: OpencodeMessage | undefined;
  for (const message of messages) {
    if (message.type === "idle") {
      summary.outcome = message.outcome;
      continue;
    }
    if (message.type !== "assistant") continue;
    newestAssistant = message;
    if (message.tokens) {
      summary.turns += 1;
      summary.inputTokens += message.tokens.input ?? 0;
      summary.outputTokens += message.tokens.output ?? 0;
      summary.reasoningTokens += message.tokens.reasoning ?? 0;
      summary.cacheReadTokens += message.tokens.cache?.read ?? 0;
      summary.cacheWriteTokens += message.tokens.cache?.write ?? 0;
    }
    summary.costUsd += messageCostUsd(message, model);
    const text = (message.content ?? [])
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => block.text)
      .join("\n");
    if (text) summary.lastAssistantText = text;
  }
  if (newestAssistant) {
    const content = (newestAssistant.content ?? []).filter((block) => block.type !== "reasoning");
    summary.endedOnText = content.at(-1)?.type === "text";
    const error = newestAssistant.error;
    if (error) summary.errorMessage = error.message ?? error.type ?? "unknown";
  }
  summary.lastAction = lastToolAction(messages.toReversed()) ?? summary.lastAction;
  return summary;
}

/** A string that changes whenever the session makes visible progress (a new message, new content,
 *  a tool changing state, token usage landing) over the NEWEST-FIRST window. Deliberately leaves
 *  out the provider-retry bookkeeping: a dead endpoint makes the server retry forever, and each
 *  retry must not look like progress to the idle watchdog. */
export function opencodeActivityFingerprint(newestFirst: OpencodeMessage[]): string {
  return JSON.stringify(
    newestFirst.map((m) => [
      m.id,
      m.type,
      m.finish,
      m.tokens?.output,
      (m.content ?? []).map((b) => [b.type, b.text?.length, b.state?.status]),
    ]),
  );
}

// ── Endpoint preflight ──────────────────────────────────────────────────────────────
//
// A dead IU endpoint makes the server retry forever (a stuck run once sat ~14 h), and a provider
// retry is deliberately not "activity" to the idle watchdog — so the unbounded case is a dead
// endpoint AT SESSION START, which this probe closes in seconds: any HTTP response (401/404
// included) = reachable, only a connect error, the abort timeout or a 5xx = unreachable.

export type IuPreflight = (
  iuOpenaiBase: string,
  timeoutMs: number,
) => Promise<{ ok: true } | { ok: false; reason: string }>;

/** The production probe. A fresh `fetch` per call (no cache): a reachable endpoint answers in
 *  milliseconds, and a cached "reachable" is exactly what a mid-day outage would outlive. The
 *  reason carries a connection-class token (`ETIMEDOUT` / `ECONNREFUSED` / `fetch failed`) so
 *  `isRetryableSessionError`, `isIuServerError` and the circuit breaker
 *  (`classifyBreakerOutcome`) all treat the failed attempt as a transport failure. */
export const preflightIuEndpoint: IuPreflight = async (iuOpenaiBase, timeoutMs) => {
  try {
    const res = await fetch(iuOpenaiBase, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.body?.cancel();
    // A gateway that answers with a server error is as dead to `opencode run` as a refused
    // connection (it retries 5xx forever), so the closed 5xx set counts as unreachable.
    // 4xx/2xx/3xx (an unauthenticated GET on the base is normally 401/404) is reachable.
    if (
      res.status === 500 ||
      res.status === 502 ||
      res.status === 503 ||
      res.status === 504 ||
      res.status === 529
    ) {
      return { ok: false, reason: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, reason: `ETIMEDOUT after ${timeoutMs}ms` };
    }
    // fetch rejects with `TypeError: fetch failed`; the errno lives on `cause`.
    const code = (err as { cause?: { code?: string } }).cause?.code;
    return { ok: false, reason: code === "ECONNREFUSED" ? code : "fetch failed (connect error)" };
  }
};

function preflightBudgetMs(): number {
  const raw = Number(process.env.AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PREFLIGHT_MS;
}

// ── Drive loop ────────────────────────────────────────────────────────────────────────

export interface OpencodeDriveInput {
  jobId: string | undefined;
  cwd: string;
  sessionId: string;
  prompt: string;
  /** Re-attach a session whose turn was cut off (no turn is running: prompt `resume`). */
  resume?: boolean;
  /** Attach to a session that is running its turn (or already finished it) on its own: no prompt
   *  is sent, only waited on. */
  attach?: boolean;
  /** A drain detaches the session instead of interrupting it (see `SessionOptions.reattachable`). */
  reattachOnDrain?: boolean;
  /** The newest `idle` message id BEFORE this prompt (resume only) — completion needs a newer one. */
  baselineIdleId?: string;
  logContext: Record<string, unknown>;
  onActivity?: (progress: SessionProgress) => void;
  onProgress?: (progress: number, total: number, message: string) => void;
  turnsRef: { current: number };
  /** Test seams — production uses the defaults. */
  pollMs?: number;
  idleTimeoutMs?: number;
}

export interface OpencodeDriveResult {
  /** Every message of THIS prompt, oldest first; empty when the final read failed. */
  messages: OpencodeMessage[];
  /** Set when the final read failed — the run's outcome and usage are unknown. */
  messagesError?: string;
  /** The session went idle on its own (as opposed to an idle kill, a cancel or a drain). */
  finished: boolean;
  /** `stop` fired: a job cancel or a drain. */
  stopped: boolean;
  /** `stopped` by a drain that left the session running for the next boot to re-attach. */
  detached: boolean;
  killReason: "idle" | null;
  idleMsAtKill: number | null;
}

const delay = (ms: number): { promise: Promise<null>; cancel: () => void } => {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

/** Prompts one session and holds it to completion. Guarantees, however it returns or throws:
 *  - the session is registered for cancel/drain (`trackExternalSession`) for its whole life, and
 *    a stop interrupts it on the server;
 *  - a session that did not finish on its own is interrupted on the server — the server keeps
 *    executing tools otherwise (measured 2.0.25);
 *  - the heartbeat timer is cleared and the in-flight `wait` is aborted.
 *  The idle watchdog is driven by the message stream (`opencodeActivityFingerprint`), not by
 *  stdout: no visible change for `IDLE_TIMEOUT_MS` means wedged. A transport failure mid-run
 *  propagates as a thrown error for the caller to classify. */
export async function driveOpencodeSession(
  client: OpencodeClient,
  input: OpencodeDriveInput,
): Promise<OpencodeDriveResult> {
  const { sessionId, jobId } = input;
  const pollMs = input.pollMs ?? ACTIVITY_POLL_MS;
  const abort = new AbortController();
  let stopped = false;
  let detached = false;
  let finished = false;
  let killReason: "idle" | null = null;
  let idleMsAtKill: number | null = null;

  const interrupt = async (reason: string): Promise<void> => {
    const result = await client.interrupt(sessionId);
    runnerLogger()[result.ok ? "info" : "warn"](
      {
        event: "session.opencode_interrupt",
        project: input.cwd,
        ...input.logContext,
        sessionId,
        reason,
        interrupted: result.interrupted,
        ok: result.ok,
        error: result.error,
      },
      "opencode server session interrupt",
    );
  };

  const untrack = trackExternalSession(jobId, (reason) => {
    if (stopped) return;
    stopped = true;
    detached = reason === "drain" && input.reattachOnDrain === true;
    abort.abort();
    if (!detached) void interrupt("stop");
  });

  let heartbeatTick = 0;
  const heartbeat = input.onProgress
    ? setInterval(() => {
        heartbeatTick++;
        input.onProgress?.(
          heartbeatTick,
          0,
          `Session running (${(heartbeatTick * HEARTBEAT_INTERVAL_MS) / 1000}s elapsed)`,
        );
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  const startWait = () =>
    client.wait(sessionId, abort.signal).then(
      (idle) => ({ idle, error: undefined as unknown }),
      (error: unknown) => ({ idle: false, error }),
    );

  /** `wait` can return before the admitted prompt has started: done only when the newest message
   *  is a NEW `idle` one. */
  const isFinished = async (): Promise<boolean> => {
    const [newest] = await client.recentMessages(sessionId, 1);
    return newest?.type === "idle" && newest.id !== input.baselineIdleId;
  };

  let lastActivityAt = Date.now();
  let lastFingerprint = "";
  const finishedTurns = new Set<string>();

  try {
    if (!input.attach) {
      await client.prompt(sessionId, {
        text: input.prompt,
        ...(input.resume ? { resume: true } : {}),
      });
    }
    let waiting = startWait();
    for (;;) {
      const tick = delay(pollMs);
      const settled = await Promise.race([waiting, tick.promise]);
      tick.cancel();
      if (stopped) break;
      if (settled) {
        if (settled.error) throw settled.error;
        if (settled.idle && (await isFinished())) {
          finished = true;
          break;
        }
        // Not finished: `wait` answered without the session being idle (a 5xx/503), or before the
        // admitted prompt started. Back off, re-arm, and FALL THROUGH so the activity poll and the
        // idle watchdog still run — never a tight request loop that starves them.
        await Bun.sleep(settled.idle ? NOT_FINISHED_RECHECK_MS : pollMs);
        if (stopped) break;
        waiting = startWait();
      }

      const recent = await client.recentMessages(sessionId, ACTIVITY_WINDOW);
      const fingerprint = opencodeActivityFingerprint(recent);
      if (fingerprint !== lastFingerprint) {
        lastFingerprint = fingerprint;
        lastActivityAt = Date.now();
        for (const m of recent) if (m.type === "assistant" && m.tokens) finishedTurns.add(m.id);
        input.turnsRef.current = Math.max(input.turnsRef.current, finishedTurns.size);
        try {
          input.onActivity?.({
            turns: input.turnsRef.current,
            lastAction: lastToolAction(recent) ?? "working",
            lastActivityAt,
          });
        } catch {
          /* best-effort */
        }
      }
      if (isIdleTimedOut(Date.now(), lastActivityAt, input.idleTimeoutMs ?? IDLE_TIMEOUT_MS)) {
        killReason = "idle";
        idleMsAtKill = Date.now() - lastActivityAt;
        runnerLogger().error(
          {
            event: "session.timeout",
            project: input.cwd,
            ...input.logContext,
            killReason,
            idleMsAtKill,
          },
          "session timed out — interrupting (opencode)",
        );
        break;
      }
    }
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    abort.abort();
    untrack();
    // Not finished = still running server-side (idle kill, cancel, a throw): stop it. After a
    // clean finish the session is idle and there is nothing to interrupt.
    if (!finished && !stopped) await interrupt(killReason ?? "error");
  }

  let messages: OpencodeMessage[] = [];
  let messagesError: string | undefined;
  try {
    // Usage is billed whether or not the run finished — read it for every exit path.
    messages = await client.allMessages(sessionId);
    // A re-attached session carries its earlier turns: attribute only what this prompt produced.
    const baselineAt = input.baselineIdleId
      ? messages.findIndex((m) => m.id === input.baselineIdleId)
      : -1;
    if (baselineAt >= 0) messages = messages.slice(baselineAt + 1);
  } catch (err) {
    messagesError = err instanceof Error ? err.message : String(err);
    runnerLogger().warn(
      {
        event: "session.opencode_messages_unavailable",
        project: input.cwd,
        ...input.logContext,
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      },
      "opencode messages unreadable after the run — usage not attributed",
    );
  }
  return { messages, messagesError, finished, stopped, detached, killReason, idleMsAtKill };
}

// ── Attempt runner ─────────────────────────────────────────────────────────────────────

export interface OpencodeAttemptContext {
  model: string;
  backend: Backend;
  variant?: string;
}

/** Test seams — production passes nothing. */
export interface OpencodeAttemptDeps {
  preflight?: IuPreflight;
  serverStatus?: () => Promise<OpencodeServerStatus>;
  password?: () => string;
  client?: OpencodeClient;
  pollMs?: number;
  idleTimeoutMs?: number;
}

/** One OpenCode session — the harness counterpart to `runSessionAttempt`'s claude path, called
 *  from there when `resolveHarness()` resolves `"opencode"`. Always the PRIMARY attempt: a forced
 *  (fallback) attempt is never opencode (`resolveHarness`'s doc comment), so `ctx.backend` here is
 *  always the route's own primary backend (`iu` for both AGENT_OC tiers). */
export async function runOpencodeAttempt<T>(
  opts: SessionOptions<T>,
  turnsRef: { current: number },
  ctx: OpencodeAttemptContext,
  deps: OpencodeAttemptDeps = {},
): Promise<SessionResult<T>> {
  const {
    cwd,
    prompt,
    jsonSchema,
    readOnly = false,
    sensitive = false,
    extraEnv,
    extraDisallowedTools,
    settingSources,
    mcpServers,
    tool,
    jobId,
    isCancelled,
    validate,
    onActivity,
    onProgress,
    resumeSessionId,
    onSessionId,
  } = opts;
  const { model, backend, variant } = ctx;

  // No caller passes this for a dispatch route — the permission profile (the `agw-*` agents,
  // opencode-server.ts) has no per-tool-name allow/deny surface to extend, unlike claude's
  // `--disallowedTools`. A caller that starts doing so needs this module updated, not a
  // silently-ignored option.
  if (extraDisallowedTools && extraDisallowedTools.length > 0) {
    throw new Error(
      "runOpencodeAttempt: extraDisallowedTools is not supported on the opencode harness",
    );
  }
  // Both are claude-CLI-specific (`--setting-sources`, `--mcp-config`) and have no OpenCode
  // equivalent wired up here. dispatch always passes `settingSources: "user,project"`, so this
  // fires on every ordinary opencode dispatch call; that is expected, not a bug to chase.
  if (settingSources !== undefined) {
    runnerLogger().debug(
      { event: "session.opencode_ignored_option", option: "settingSources", value: settingSources },
      "settingSources has no effect on the opencode harness",
    );
  }
  if (mcpServers) {
    runnerLogger().debug(
      { event: "session.opencode_ignored_option", option: "mcpServers" },
      "mcpServers has no effect on the opencode harness",
    );
  }

  // Defense in depth, mirrored at the routing-table level (routing.ts validates every route
  // against the registry) — this is the layer that guards a hand-built route too. Refuses an
  // unregistered/non-opencode model, and a variant the model's registry `effort` does not
  // list: opencode itself silently accepts an undeclared variant (falls back to the base
  // `options`), which would mask a typo'd override as "ran, just not the effort asked for".
  const registryModel = opencodeModel(model);
  if (variant !== undefined && !registryModel.effort.includes(variant)) {
    throw new Error(
      `runOpencodeAttempt: unknown opencode variant "${variant}" for ${model} — declared variants are ` +
        (registryModel.effort.join(", ") || "none"),
    );
  }

  const sessionUuid = randomUUID();
  const tsStart = new Date().toISOString();
  const errCtx = { tool, model, backend, harness: "opencode" as const, jobId };

  let iuKey: string;
  let iuOpenaiBase: string;
  try {
    const cfg = await getIuConfig();
    iuKey = cfg.key;
    iuOpenaiBase = cfg.openaiBase;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runnerLogger().error(
      { event: "session.iu_config_error", project: cwd, ...errCtx, error: message },
      "IU config unavailable (opencode)",
    );
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome: "error",
      reason: "iu_config_error",
    });
    return {
      ok: false,
      error: message,
      classificationText: message,
      backend,
      model,
      iuConfigError: true,
    };
  }

  // Never start a session against a dead endpoint or server: the server retries a dead IU
  // endpoint forever. Both are classified as transport failures (connection-class text, no
  // `iuConfigError` — the breaker must count them), so the retry ladder and the Max fallback
  // treat them as such.
  const refuse = (reason: string, error: string, logMessage: string): SessionResult<T> => {
    runnerLogger().error(
      { event: `session.${reason}`, project: cwd, ...errCtx, error },
      logMessage,
    );
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome: "error",
      reason,
    });
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      backend,
      model,
    };
  };

  if (jobId !== undefined && isCancelled?.(jobId)) throw new SessionCancelledError(jobId);
  const probe = await (deps.preflight ?? preflightIuEndpoint)(iuOpenaiBase, preflightBudgetMs());
  if (!probe.ok) {
    return refuse(
      "opencode_preflight_failed",
      `IU endpoint unreachable before opencode session: ${probe.reason}`,
      "IU endpoint unreachable — no opencode session created",
    );
  }

  // The shared server must be up AND the pinned build; the text carries a connection-class
  // token whatever the cause (down, wrong version, rejected password) so a wrong-version server
  // falls through to the Max fallback instead of failing the episode outright.
  const server = await (deps.serverStatus ?? getOpencodeServerStatus)();
  if (!server.ok) {
    return refuse(
      "opencode_server_unavailable",
      `opencode server unavailable before session (transport-class, fetch failed): ${server.error ?? "not ok"}`,
      "opencode server unavailable — no opencode session created",
    );
  }
  const password = (deps.password ?? readServerPassword)();
  const client = deps.client ?? createOpencodeClient();

  // The session's shell env: the caller's env, then the server's credentials blanked (defense in
  // depth — the shell tool does not inherit the server env on 2.0.25) and the git credential deny
  // last, so a caller cannot loosen either.
  const sessionEnv: Record<string, string> = {
    ...extraEnv,
    ...Object.fromEntries(OPENCODE_SESSION_BLANKED_ENV.map((name) => [name, ""])),
    ...GIT_DENY_CREDENTIALS_ENV,
  };

  runnerLogger().info(
    {
      event: "session.spawn",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      readOnly,
      variant,
    },
    "session start (opencode)",
  );

  const startMs = performance.now();
  if (jobId !== undefined && isCancelled?.(jobId)) throw new SessionCancelledError(jobId);

  const finalPrompt = jsonSchema ? appendJsonSchemaInstruction(prompt, jsonSchema) : prompt;
  let drive: OpencodeDriveResult;
  let sessionId = resumeSessionId;
  try {
    let baselineIdleId: string | undefined;
    let attach = false;
    if (sessionId) {
      // A boot-recovery resume. The session lives on the server, so it is in one of three states:
      // running its turn (a detached drain — attach, never prompt: a second prompt would steer
      // a nudge into live work), already idle after a succeeded turn (finished while agw was
      // down — read the result), or cut off (a killed server — prompt `resume`).
      // `active` FIRST: a session that finishes between the two reads is then caught by the
      // messages read (finished) instead of falling through to a re-prompt of a done episode.
      const live = (await client.active()).includes(sessionId);
      const [newest] = await client.recentMessages(sessionId, 1);
      // Any idle that is not a failed/interrupted turn is a finished one (an absent outcome too).
      const finishedOnItsOwn =
        newest?.type === "idle" && newest.outcome !== "failed" && newest.outcome !== "interrupted";
      attach = live || finishedOnItsOwn;
      baselineIdleId = !finishedOnItsOwn && newest?.type === "idle" ? newest.id : undefined;
      const mode = live ? "live" : finishedOnItsOwn ? "finished" : "resume";
      runnerLogger().info(
        {
          event: "session.opencode_reattach",
          project: cwd,
          ...errCtx,
          sessionId,
          mode,
        },
        "opencode session re-attached after a restart",
      );
    } else {
      const agent = readOnly
        ? sensitive
          ? OPENCODE_AGENT_READONLY_SENSITIVE
          : OPENCODE_AGENT_READONLY
        : OPENCODE_AGENT_IMPLEMENT;
      // The server accepts a session for an agent it does not have (measured 2.0.25), running it
      // under permissions nobody chose — so fail closed. Worded as a transport-class failure like
      // the other server-unavailable refusals: the retry ladder and the caller retry it, and
      // `make install-opencode-agent` (or the next deploy) loads the current config.
      if (!(await client.listAgents()).includes(agent)) {
        throw new Error(
          `opencode server lacks agent ${agent} (transport-class, fetch failed): its config is stale — make install-opencode-agent`,
        );
      }
      sessionId = await client.createSession({
        directory: cwd,
        model: { providerID: opencodeProviderForWire(registryModel.wire), id: model, variant },
        agent,
        title: `agw ${tool ?? "episode"}`,
        metadata: { agw: { jobId, tool } },
      });
    }
    announceOpencodeSessionId(sessionId, { iuOpenaiBase, model, backend, tool, onSessionId });
    if (!attach) await client.setEnvironment(sessionId, sessionEnv);
    drive = await driveOpencodeSession(client, {
      jobId,
      cwd,
      sessionId,
      prompt: finalPrompt,
      resume: !attach && resumeSessionId !== undefined,
      attach,
      reattachOnDrain: opts.reattachable === true,
      baselineIdleId,
      logContext: errCtx,
      onActivity,
      onProgress,
      turnsRef,
      pollMs: deps.pollMs,
      idleTimeoutMs: deps.idleTimeoutMs ?? opts.idleTimeoutMs,
    });
  } catch (err) {
    // The server became unreachable (or answered garbage) mid-setup or mid-run. The error text
    // carries a connection-class token for transport failures, so the retry ladder and the
    // breaker read it as such; the message never includes a response body.
    const error = redactSecret(
      redactSecret(err instanceof Error ? err.message : String(err), iuKey),
      password,
    );
    runnerLogger().error(
      { event: "session.opencode_error", project: cwd, ...errCtx, sessionId, error },
      "opencode session failed",
    );
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome: "error",
      durationMs: Math.round(performance.now() - startMs),
      reason: "opencode_session_error",
    });
    return { ok: false, error, classificationText: error, hadApiRetry: false, backend, model };
  }
  // A drain detached the session: it keeps running on the server and the next boot attaches to it.
  // Its usage is NOT attributed here (the attaching attempt reads the whole turn), so nothing is
  // billed twice.
  if (drive.detached) {
    runnerLogger().warn(
      { event: "session.opencode_detached", project: cwd, ...errCtx, sessionId },
      "opencode session left running for re-attach after the restart",
    );
    throw new SessionDetachedError(jobId);
  }
  // The run ended on its own but its messages could not be read: outcome and usage are unknown.
  // Fail as a transport-class error (connection text) instead of collapsing into "no output".
  if (drive.messagesError && drive.finished && !drive.stopped && !drive.killReason) {
    const error = `opencode server unreachable reading messages after the run (fetch failed): ${redactSecret(redactSecret(drive.messagesError, iuKey), password)}`;
    writeAttribution({
      sessionId: sessionUuid,
      opencodeSessionId: sessionId,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome: "error",
      durationMs: Math.round(performance.now() - startMs),
      reason: "messages_unreadable",
    });
    return { ok: false, error, classificationText: error, hadApiRetry: false, backend, model };
  }

  // The server's env held the IU key and password; the session blanks them, but a worker can still
  // read the password FILE or be asked to echo anything — redact both out of everything that could
  // echo them back BEFORE it is used to build an error message or parsed/returned as data.
  const redact = (text: string): string => redactSecret(redactSecret(text, iuKey), password);
  const summary = summarizeOpencodeMessages(drive.messages, registryModel);
  summary.lastAssistantText = redact(summary.lastAssistantText);
  if (summary.errorMessage) summary.errorMessage = redact(summary.errorMessage);
  turnsRef.current = summary.turns;

  const durationMs = Math.round(performance.now() - startMs);
  const costFields = {
    costUsd: summary.costUsd,
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    // Named `thinkingTokens` here (not `reasoningTokens`) to match the claude path's own
    // attribution field name (session-runner.ts's `costFields`) — one consistent column for
    // usage-tracker regardless of which harness produced the row.
    thinkingTokens: summary.reasoningTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
  };
  const emitAttribution = (
    outcome: "ok" | "error" | "timeout_idle",
    extras: Record<string, unknown> = {},
  ) =>
    writeAttribution({
      sessionId: sessionUuid,
      opencodeSessionId: sessionId,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome,
      durationMs,
      turns: summary.turns,
      ...costFields,
      ...extras,
    });

  if (drive.killReason) {
    emitAttribution("timeout_idle", {
      killReason: drive.killReason,
      idleMsAtKill: drive.idleMsAtKill,
    });
    const error = `Session timed out — idle ${drive.idleMsAtKill}ms with no new messages (budget ${deps.idleTimeoutMs ?? opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS}ms)`;
    return { ok: false, error, classificationText: error, hadApiRetry: false, backend, model };
  }

  const salvage = summary.lastAssistantText
    ? { noOutput: true as const, rawText: summary.lastAssistantText }
    : {};

  if (drive.stopped) {
    emitAttribution("error", { reason: "interrupted" });
    const error = "opencode session interrupted by request (cancel or drain)";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      backend,
      model,
      ...salvage,
    };
  }

  // An `error` on the newest assistant message, or a failed/interrupted idle outcome, is the
  // failure signal — CLI/tool-sourced, same standing as claude's `envelope.errors[]`, so safe to
  // classify. `noOutput: true` so `isSalvageable` (dispatch.ts) still gets one retry out of a
  // partial `lastAssistantText`.
  if (summary.errorMessage || summary.outcome === "failed" || summary.outcome === "interrupted") {
    emitAttribution("error", { reason: summary.errorMessage ? "error_event" : "idle_outcome" });
    const error = `opencode error: ${summary.errorMessage ?? `session ended ${summary.outcome ?? "without an outcome"}`}`;
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: summary.lastAssistantText || undefined,
      backend,
      model,
    };
  }

  if (!summary.lastAssistantText) {
    emitAttribution("error", { reason: "no_output" });
    const error = "opencode session produced no output (no final assistant text)";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      backend,
      model,
    };
  }

  if (!summary.endedOnText) {
    emitAttribution("error", { reason: "truncated_stream" });
    const error = "opencode session ended on a tool call, not a final assistant message";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: summary.lastAssistantText,
      backend,
      model,
    };
  }

  const parsed = extractJson<T>(summary.lastAssistantText);
  if (parsed === undefined) {
    emitAttribution("error", { reason: "json_parse" });
    return unclassifiedOutputFailure<T>(
      `final message is not valid JSON: ${summary.lastAssistantText.slice(0, 500)}`,
      summary.lastAssistantText,
      false,
      backend,
      model,
    );
  }

  if (validate) {
    const v = validate(parsed);
    if (!v.ok) {
      emitAttribution("error", { reason: "invalid_output" });
      const asText = typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 2);
      return unclassifiedOutputFailure<T>(v.error, asText, false, backend, model);
    }
    emitAttribution("ok");
    return { ok: true, data: v.value, backend, model };
  }

  emitAttribution("ok");
  return { ok: true, data: parsed as T, backend, model };
}
