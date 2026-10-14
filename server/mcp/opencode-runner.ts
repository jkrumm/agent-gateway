// ── OpenCode harness — the second worker CLI ────────────────────────────────────────
//
// `dispatch`/`dispatch_implement` (AGENT_OC/AGENT_OC_IMPLEMENT, server/lib/routing.ts) run
// `opencode run` instead of `claude -p` — see routing.ts's module-header Harness paragraph
// for why. This module owns everything specific to driving that CLI: argv/env builders (pure,
// unit-tested directly; the SERVER it attaches to — config, permission agents, state, status —
// is `opencode-server.ts`), its NDJSON event shape (measured against real `opencode run --format
// json` output — re-captured from opencode 2.0.25 on 2026-10-11, see
// tests/fixtures/opencode-events*.jsonl), the per-process
// lifecycle (`runOpencodeProcessLifecycle`) and one attempt runner (`runOpencodeAttempt`),
// invoked from `session-runner.ts`'s `runSessionAttempt` whenever `resolveHarness()` resolves
// to `"opencode"`. It returns the exact same `SessionResult<T>` shape the claude path does, so
// `runSession`'s retry/fallback loop (`planNextAttempt`), `POST /api/jobs/:id/cancel`
// (`terminateSessionsForJob`, via the shared `activeProcs` registration below), the idle
// watchdog, and `onActivity`/`onProgress`/`onSessionId` all keep working unmodified — this
// module is a second engine under the same chassis, not a parallel pipeline.
//
// Deliberately NOT `--pure` (measured 2026-09-24: hangs — see AGENTS.md's Worker routing
// section).
//
// Supports any model in the registry (`server/lib/models.ts`) whose `harnesses` include
// `opencode`: the cost computation comes from the registry entry of the model in use, and
// `runOpencodeAttempt` refuses an unregistered or non-opencode id outright. The registry's
// `wire` picks the provider (`iu-chat`/`iu-responses`) and therefore the `-m` prefix — GPT ids
// ride Responses only.
//
// Episodes attach to ONE long-lived server (`opencode run --server <url> --agent <agw agent>`,
// docs/opencode-v2.md): per-run permissions are the agent, per-run env is impossible (the shell
// inherits the server's env — `assertExtraEnvCarriedByServer`), and an unreachable or
// wrong-version server fails the attempt before any spawn, as a transport-class failure.

import { randomUUID } from "node:crypto";
import type { Subprocess } from "bun";
import { getIuConfig } from "../lib/iu-openai.ts";
import { getModel, type ModelEntry } from "../lib/models.ts";
import type { Backend } from "../lib/routing.ts";
import { IDLE_TIMEOUT_MS } from "../lib/idle-timeout.ts";
import {
  extractJson,
  isIdleTimedOut,
  runnerLogger,
  SessionCancelledError,
  trackExternalProc,
  unclassifiedOutputFailure,
  writeAttribution,
  writeSessionEnv,
  type SessionOptions,
  type SessionProgress,
  type SessionResult,
} from "./session-runner.ts";
import {
  getOpencodeServerStatus,
  interruptOpencodeSession,
  OPENCODE_AGENT_IMPLEMENT,
  OPENCODE_AGENT_READONLY,
  OPENCODE_DROPPED_EXTRA_ENV,
  opencodeProviderForWire,
  opencodeServerCarriedEnv,
  opencodeServerUrl,
  readServerPassword,
  type OpencodeServerStatus,
} from "./opencode-server.ts";
import { readTrimmedLines, workerBaseEnv } from "./worker-shared.ts";

// ── Binary resolution ─────────────────────────────────────────────────────────
//
// `OPENCODE_BIN` env override first (matches every other externally-invoked binary's
// override convention in this codebase — e.g. `CLAUDE_BIN` in session-runner.ts reads
// `~/.local/bin/claude` before falling back to PATH); then `Bun.which`, which actually
// resolves PATH at call time rather than guessing a single hardcoded Homebrew prefix (the
// previous `existsSync("/opt/homebrew/...")` check silently returned bare `"opencode"` —
// relying on the CHILD process's PATH containing it — on any Intel Mac or Linux box); a
// literal `"opencode"` last so a spawn still gets a clear "command not found" rather than
// this module refusing to load when neither resolves.
const OPENCODE_BIN = process.env.OPENCODE_BIN ?? Bun.which("opencode") ?? "opencode";

// ── Named constants (no magic numbers) ──────────────────────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;
const IDLE_CHECK_INTERVAL_MS = 5_000;
const SIGKILL_GRACE_MS = 5_000;
/** Reachability-probe budget before any `opencode run` spawn — see `preflightIuEndpoint`.
 *  Override: `AGENT_GATEWAY_OPENCODE_PREFLIGHT_MS` (read per call, so no reload for a test). */
const DEFAULT_PREFLIGHT_MS = 5_000;

/** `Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env })` (no explicit `stdin`, which
 *  defaults to `"ignore"`) is what every spawn site in this file actually produces — this
 *  alias names that exact shape once instead of every caller re-deriving it, and is what
 *  `runOpencodeProcessLifecycle` accepts so a test can inject a fake object of the same shape
 *  without spawning a real process. */
export type OpencodeSubprocess = Subprocess<"ignore", "pipe", "pipe">;

// ── Pure builders ──────────────────────────────────────────────────────────────

export interface OpencodeArgsInput {
  bin: string;
  /** The shared server's base URL (`opencodeServerUrl()`). */
  url: string;
  /** Selects the `agw-readonly` or `agw-implement` agent — the per-run permission profile. */
  readOnly: boolean;
  model: string;
  variant?: string;
  resumeSessionId?: string;
  prompt: string;
}

/** The registry entry for a model this harness can drive, or a thrown refusal: unregistered,
 *  or no `opencode` in its `harnesses` (e.g. the Anthropic-wire ids, which only `claude -p`
 *  reaches). */
export function opencodeModel(model: string): ModelEntry & { wire: "chat" | "responses" } {
  const entry = getModel(model);
  if (!entry) {
    throw new Error(`opencode harness: unknown model "${model}" — not in the registry`);
  }
  if (!entry.harnesses.includes("opencode") || entry.wire === "anthropic") {
    throw new Error(`opencode harness: model "${model}" is not usable on the opencode harness`);
  }
  return entry as ModelEntry & { wire: "chat" | "responses" };
}

/** The full `opencode` argument vector, INCLUDING the binary as element 0. Targets the 2.x CLI:
 *  opencode 2.0 dropped `run --dir` and `--variant`. The working directory is no longer a flag —
 *  opencode 2.x resolves it from the inherited `PWD` env var, NOT from `Bun.spawn`'s `cwd`
 *  (measured 2026-10-11 on 2.0.25; still true with `--server`, 2026-10-14), so
 *  `buildOpencodeEnv` pins `env.PWD` to the spawn `cwd` itself. `--server <url>` attaches to the
 *  shared server (opencode-server.ts) instead of a private `--standalone` one, and `--agent`
 *  picks the permission profile defined in that server's config — `run --server` has no
 *  permission, env or config flag, so the agent IS the per-run policy. `-m <provider>/<model>`
 *  names the provider (`iu-chat`/`iu-responses`, from the server config) and the model id
 *  together — opencode has no bare `--model <id>` against a custom provider — with the reasoning
 *  variant appended as `#<variant>` (2.x's `provider/model#variant` form). The `--` before
 *  `prompt` is load-bearing, not decorative: measured 2026-09-24, a message starting with `-`
 *  (e.g. a brief that happens to begin "-foo bar") is parsed by opencode's own yargs CLI as an
 *  unknown FLAG without it — the command prints --help and exits 0 with no session ever
 *  starting, which this module would otherwise only see as an opaque "no output" failure. */
export function buildOpencodeArgs(input: OpencodeArgsInput): string[] {
  const { bin, url, readOnly, model, variant, resumeSessionId, prompt } = input;
  const provider = opencodeProviderForWire(opencodeModel(model).wire);
  return [
    bin,
    "run",
    "--server",
    url,
    "--agent",
    readOnly ? OPENCODE_AGENT_READONLY : OPENCODE_AGENT_IMPLEMENT,
    "-m",
    `${provider}/${model}${variant ? `#${variant}` : ""}`,
    ...(resumeSessionId ? ["--session", resumeSessionId] : []),
    "--format",
    "json",
    "--",
    prompt,
  ];
}

/** Env vars an inherited environment may carry that point opencode at another config source;
 *  the client process must resolve none of them (the server's config is the only one that
 *  matters, and it was fixed when the server started). */
const INHERITED_CONFIG_ENV = [
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
  "OPENCODE_CONFIG_CONTENT",
  "OPENCODE_CLI_CONFIG_CONTENT",
];

export interface OpencodeEnvInput {
  tool?: string;
  /** The spawn working directory, pinned as `env.PWD` — opencode 2.x resolves its cwd from
   *  the inherited `PWD` env var, not `Bun.spawn`'s `cwd` option, and `workerBaseEnv` copies
   *  `process.env` verbatim (including the server's own stale `PWD`), so without this the
   *  session's shell/read tools run against the ambient `PWD`, not the worktree. With
   *  `run --server` the client's cwd/PWD is still what the server honours (measured 2.0.25). */
  cwd: string;
  /** The server's HTTP Basic password (`readServerPassword`), handed over env, never argv. */
  password: string;
  /** Override for tests — defaults to `process.env`, same convention as `WorkerEnvInput`. */
  baseEnv?: Record<string, string | undefined>;
}

/** The CLIENT process's env — the same credential scrub, `CLAUDE_*` session-var handling and
 *  `USAGE_LANE` tagging as `buildWorkerEnv` (session-runner.ts), via the shared
 *  `workerBaseEnv` (worker-shared.ts), so usage-tracker's claude-code collector still finds a
 *  coherent env shape from either harness; plus `PWD` and the server password (added AFTER the
 *  scrub, which would delete a `*PASSWORD*` name). The IU key is not here: the shared server
 *  holds it (opencode-server.ts), the client never talks to IU.
 *
 *  This env does NOT reach the worker's shell — that is the server process's env (measured
 *  2026-10-14 on 2.0.25), which is why `runOpencodeAttempt` refuses any `extraEnv` the server
 *  does not already carry (`assertExtraEnvCarriedByServer`). */
export function buildOpencodeEnv(input: OpencodeEnvInput): Record<string, string> {
  const { tool, cwd, password, baseEnv = process.env } = input;
  const env = workerBaseEnv(baseEnv, tool);
  for (const k of INHERITED_CONFIG_ENV) delete env[k];
  env.PWD = cwd;
  env.OPENCODE_SERVER_PASSWORD = password;
  return env;
}

/** Throws unless every `extraEnv` entry is one the shared server already carries, with the same
 *  value (`opencodeServerCarriedEnv`). A shared server takes no per-run env, so a caller adding
 *  a new variable would otherwise lose it silently; a value that differs from the server's is
 *  refused for the same reason. The one exception is `OPENCODE_DROPPED_EXTRA_ENV` (the
 *  research-gateway credentials): those are credentials the server must NOT carry — any worker
 *  shell on it could read them — so they are returned as `dropped` for the caller to log, and
 *  research validation is unavailable on OpenCode review angles until per-session env (Wave 3). */
export function assertExtraEnvCarriedByServer(
  extraEnv: Record<string, string> | undefined,
  carried: Record<string, string> = opencodeServerCarriedEnv(),
): { dropped: string[] } {
  if (!extraEnv) return { dropped: [] };
  const droppable = new Set<string>(OPENCODE_DROPPED_EXTRA_ENV);
  const dropped = Object.keys(extraEnv).filter((key) => droppable.has(key));
  const rejected = Object.entries(extraEnv)
    .filter(([key, value]) => !droppable.has(key) && carried[key] !== value)
    .map(([key]) => key);
  if (rejected.length > 0) {
    throw new Error(
      `runOpencodeAttempt: extraEnv ${rejected.join(", ")} cannot reach a worker on the shared ` +
        "opencode server (its shell inherits the SERVER's env, fixed at server start) — add the " +
        "variable to opencodeServerCarriedEnv() in opencode-server.ts and restart the server, or " +
        "run the route on the claude harness",
    );
  }
  return { dropped };
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

// ── NDJSON event shape (re-measured 2026-10-11 on 2.0.25 against real `opencode run --format json`
// output — tests/fixtures/opencode-events.jsonl (a successful run) and
// tests/fixtures/opencode-events-error.jsonl (two real failing runs: an unrecognized model id,
// a rejected apiKey) are trimmed excerpts of the actual streams) ──

interface OpencodeToolState {
  status?: "completed" | "error" | string;
  input?: Record<string, unknown>;
  output?: string;
  error?: string;
}

interface OpencodePart {
  type?: string; // "step-start" | "tool" | "text" | "step-finish"
  tool?: string;
  state?: OpencodeToolState;
  text?: string;
  reason?: string; // step-finish: "tool-calls" | "stop" | …
  tokens?: {
    total?: number;
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  cost?: number;
}

/** The shape of a real `type: "error"` event's `error` field. opencode 2.x INLINED it — the
 *  error is now a FLAT `{type, message}` object, e.g.
 *  `{type:"provider.no-route", message:"Model unavailable: iu-chat/…"}` or
 *  `{type:"provider.auth", message:"Provider request failed with HTTP 401: …", status:401}`
 *  (measured 2026-10-11 on 2.0.25, tests/fixtures/opencode-events-error.jsonl). Reading the
 *  1.x `event.error?.data?.message ?? event.error?.name` shape here left `errorMessage` always
 *  `undefined` on 2.x, collapsing every failure into the generic "opencode error: unknown". The
 *  1.x nested `{name, data:{message}}` fields are kept below as a fallback so an old binary's
 *  stream still yields a real message. This is an OBJECT, not a bare string — a flat
 *  `error?: string` never matched anything real. */
interface OpencodeErrorDetail {
  /** 2.x machine class, e.g. "provider.no-route" / "provider.auth" (fallback when no message). */
  type?: string;
  /** 2.x human-readable message — the field `reduceOpencodeEvent` surfaces. */
  message?: string;
  /** HTTP status, when the provider answered with one (2.x). */
  status?: number;
  /** 1.x legacy shape, retained as a fallback. */
  name?: string;
  data?: {
    message?: string;
    statusCode?: number;
    isRetryable?: boolean;
    [key: string]: unknown;
  };
}

interface OpencodeEvent {
  type?: "step_start" | "tool_use" | "text" | "step_finish" | "error";
  sessionID?: string;
  part?: OpencodePart;
  error?: OpencodeErrorDetail;
}

/** Best-effort NDJSON line parse — a malformed line is skipped, same as the claude path's own
 *  stream-json parser. Split out purely to keep the caller's loop one nesting level shallower. */
function parseOpencodeLine(trimmed: string): OpencodeEvent | undefined {
  try {
    return JSON.parse(trimmed) as OpencodeEvent;
  } catch {
    return undefined;
  }
}

/** Fires exactly once per attempt, the instant opencode's own transcript sessionID is first
 *  observed — mirrors claude path's `maybeWriteSessionEnv`/`onSessionId` pairing. Split out
 *  purely to keep the caller's loop one nesting level shallower. */
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

/** Compact human label for a tool_use part, mirroring `describeTool` in session-runner.ts —
 *  same shape of output ("bash: <cmd>", "edit <basename>"), different input shape
 *  (`part.tool`/`part.state.input` rather than claude's `name`/`input`). The shell-command tool
 *  is named `bash` in opencode 1.x and `shell` in 2.x (measured 2026-10-11 on 2.0.25), so both
 *  are labelled `${tool}: <cmd>`. */
function describeOpencodeTool(part: OpencodePart): string {
  const tool = part.tool ?? "tool";
  const input = part.state?.input ?? {};
  if ((tool === "bash" || tool === "shell") && typeof input.command === "string") {
    return `${tool}: ${input.command.slice(0, 50)}`;
  }
  const path = input.filePath ?? input.path;
  if (typeof path === "string") {
    return `${tool} ${path.split("/").pop()}`;
  }
  return tool;
}

export interface OpencodeAccum {
  turns: number;
  lastAction: string;
  lastAssistantText: string;
  /** True while the newest content event is an assistant `text` (no `tool_use` after it). The
   *  completion signal on 2.x, where the terminal `step_finish` is dropped: a stream cut off
   *  mid-loop ends on a `tool_use` (or earlier narration text followed by one), so its
   *  `lastAssistantText` is narration, not a verdict, even when the process exits 0. */
  endedOnText: boolean;
  sessionId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  sawErrorEvent: boolean;
  errorMessage?: string;
  /** True when the most recent assistant `text` event was never followed by a `step_finish` —
   *  opencode 2.x under `--standalone` drops the terminal step_finish (measured 2026-10-11),
   *  so the final answer turn's tokens/cost are NOT in `inputTokens`/`outputTokens`/etc. A
   *  completed stream reads this at the end: `true` means the run was billed only its
   *  pre-final-turn usage, and is flagged as not-fully-accounted. Advisory only: recorded on the attribution row for
   *  cost tracking, never a completion gate. */
  usageIncomplete: boolean;
}

export const INITIAL_OPENCODE_ACCUM: OpencodeAccum = {
  turns: 0,
  lastAction: "starting",
  lastAssistantText: "",
  endedOnText: false,
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  sawErrorEvent: false,
  usageIncomplete: false,
};

/** Pure event-fold: one NDJSON line in, the next accumulator state out. No I/O, no callbacks
 *  — the imperative caller diffs `sessionId` before/after to fire `onSessionId` exactly once,
 *  same pattern as claude's own `maybeWriteSessionEnv`. */
export function reduceOpencodeEvent(state: OpencodeAccum, event: OpencodeEvent): OpencodeAccum {
  const next = { ...state };
  if (event.sessionID && !next.sessionId) next.sessionId = event.sessionID;
  const part = event.part;
  switch (event.type) {
    case "tool_use":
      if (part) next.lastAction = describeOpencodeTool(part);
      next.endedOnText = false;
      break;
    case "text":
      if (typeof part?.text === "string" && part.text.trim()) {
        next.lastAssistantText = part.text;
        next.endedOnText = true;
        // A text turn whose usage is not yet closed by a `step_finish` — the terminal turn
        // on 2.x standalone. Cleared by the next `step_finish` below.
        next.usageIncomplete = true;
      }
      break;
    case "step_finish":
      next.turns += 1;
      if (part?.tokens) {
        next.inputTokens += part.tokens.input ?? 0;
        next.outputTokens += part.tokens.output ?? 0;
        next.reasoningTokens += part.tokens.reasoning ?? 0;
        next.cacheReadTokens += part.tokens.cache?.read ?? 0;
        next.cacheWriteTokens += part.tokens.cache?.write ?? 0;
      }
      next.usageIncomplete = false;
      // A mid-loop step ("tool-calls") means the loop continues: any earlier text was narration.
      if (part?.reason !== undefined && part.reason !== "stop") next.endedOnText = false;
      break;
    case "error":
      next.sawErrorEvent = true;
      next.errorMessage =
        event.error?.message ??
        event.error?.data?.message ??
        event.error?.type ??
        event.error?.name ??
        next.errorMessage;
      break;
    default:
      break;
  }
  return next;
}

/** Reasoning tokens billed at the output rate, same convention as claude/Anthropic usage
 *  accounting elsewhere in this codebase (see iu-openai.ts's `normalizeUsage` doc comment). */
export function computeOpencodeCostUsd(
  accum: Pick<
    OpencodeAccum,
    "inputTokens" | "outputTokens" | "reasoningTokens" | "cacheReadTokens"
  >,
  model: string,
): number {
  const { rate } = opencodeModel(model);
  const outputBilled = accum.outputTokens + accum.reasoningTokens;
  // No registry cache rate → 0.1x input (never free) — same convention as models.ts.
  const cacheRead = rate.cacheRead ?? rate.in * 0.1;
  return (
    (accum.inputTokens / 1_000_000) * rate.in +
    (outputBilled / 1_000_000) * rate.out +
    (accum.cacheReadTokens / 1_000_000) * cacheRead
  );
}

// ── Endpoint preflight ──────────────────────────────────────────────────────────
//
// `opencode run` retries connect errors and 5xx forever (a stuck run once sat ~14 h against an
// unreachable endpoint). The 5 min idle watchdog in `runOpencodeProcessLifecycle` is the only
// mid-run bound — the measured NDJSON streams (tests/fixtures/opencode-events*.jsonl) carry NO
// retry/progress-less event type, only terminal `error` events, and opencode's retry chatter
// goes to stderr, which never resets the idle clock (only stdout chunks do) — so there is no
// separate "retries without progress" budget to add. The unbounded case is a dead endpoint AT
// SPAWN, which this probe closes in seconds: any HTTP response (401/404 included) = reachable,
// only a connect error or the abort timeout = unreachable.

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

// ── Per-process lifecycle ─────────────────────────────────────────────────────
//
// Extracted out of `runOpencodeAttempt` so this exact lifecycle — registration into the
// shared `activeProcs` map, the idle watchdog, the progress heartbeat, and (critically) the
// teardown guarantee — is unit-testable against a FAKE `proc` (a Bun.Subprocess-shaped
// object, same convention `tests/session-runner-cancel.test.ts`'s `fakeProc()` uses) without
// spawning a real `opencode` binary or waiting on real timers.

export interface OpencodeProcLifecycleCtx {
  jobId: string | undefined;
  cwd: string;
  model: string;
  backend: Backend;
  tool: string | undefined;
  iuOpenaiBase: string;
  onSessionId?: (sessionId: string) => void;
  onActivity?: (progress: SessionProgress) => void;
  onProgress?: (progress: number, total: number, message: string) => void;
  turnsRef: { current: number };
  /** Override for tests only — the real SIGKILL escalation grace period is
   *  `SIGKILL_GRACE_MS` (5s); a test asserting "a SIGTERM-ignoring child still gets
   *  SIGKILL" would otherwise have to burn 5 real seconds per run. */
  sigkillGraceMs?: number;
  /** Test seam for the server-side stop; production uses `interruptOpencodeSession`. */
  interrupt?: typeof interruptOpencodeSession;
}

export interface OpencodeProcLifecycleResult {
  accum: OpencodeAccum;
  eventCount: number;
  exitCode: number;
  stderrTrimmed: string;
  killReason: "idle" | null;
  idleMsAtKill: number | null;
}

/** Runs ONE already-spawned opencode process to completion. Guarantees, regardless of how
 *  this function returns (including a `reader.read()` throw):
 *   - the process is registered into `activeProcs` (`trackExternalProc`) for the duration,
 *     and untracked the moment it actually exits (`void proc.exited.finally(untrack)` — the
 *     exact pattern `runSessionAttempt`'s own claude-path spawn uses), not merely when this
 *     function happens to reach its own cleanup code;
 *   - the idle watchdog and progress heartbeat intervals are always cleared;
 *   - the child is never left running: a `finally` around the read loop force-kills it
 *     (SIGTERM, escalating to SIGKILL after `SIGKILL_GRACE_MS` if it ignores the signal) if
 *     it hasn't already exited, whether that's because of an idle timeout OR because the read
 *     loop itself threw for some other reason;
 *   - the SIGKILL escalation timer is only cleared AFTER `proc.exited` resolves — clearing it
 *     earlier could race a kill that fires between the read loop's `finally` and the
 *     `exited` await, cancelling a legitimate pending SIGKILL before it had a chance to run. */
export async function runOpencodeProcessLifecycle(
  proc: OpencodeSubprocess,
  ctx: OpencodeProcLifecycleCtx,
): Promise<OpencodeProcLifecycleResult> {
  const errCtx = {
    tool: ctx.tool,
    model: ctx.model,
    backend: ctx.backend,
    harness: "opencode" as const,
    jobId: ctx.jobId,
  };
  const untrack = trackExternalProc(proc, ctx.jobId);
  void proc.exited.finally(untrack);

  let heartbeatTick = 0;
  const onProgress = ctx.onProgress;
  const heartbeatHandle = onProgress
    ? setInterval(() => {
        heartbeatTick++;
        onProgress(heartbeatTick, 0, `Session running (${heartbeatTick * 15}s elapsed)`);
      }, HEARTBEAT_INTERVAL_MS)
    : null;

  let accum: OpencodeAccum = INITIAL_OPENCODE_ACCUM;
  let eventCount = 0;
  let killReason: "idle" | null = null;
  let idleMsAtKill: number | null = null;
  let lastChunkAt: number | null = null;
  const spawnedAt = Date.now();
  let sigkillTimer: ReturnType<typeof setTimeout> | null = null;

  const forceKill = (): void => {
    if (proc.exitCode !== null) return;
    proc.kill("SIGTERM");
    sigkillTimer = setTimeout(() => {
      sigkillTimer = null;
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, ctx.sigkillGraceMs ?? SIGKILL_GRACE_MS);
  };
  const kill = (reason: "idle"): void => {
    if (killReason) return;
    killReason = reason;
    idleMsAtKill = Date.now() - (lastChunkAt ?? spawnedAt);
    runnerLogger().error(
      { event: "session.timeout", project: ctx.cwd, ...errCtx, killReason, idleMsAtKill },
      "session timed out — SIGTERM (opencode)",
    );
    forceKill();
  };
  const idleWatchdog = setInterval(() => {
    if (isIdleTimedOut(Date.now(), lastChunkAt ?? spawnedAt)) kill("idle");
  }, IDLE_CHECK_INTERVAL_MS);

  const stderrPromise = new Response(proc.stderr).text();
  const emitActivity = () => {
    if (!ctx.onActivity) return;
    try {
      ctx.onActivity({
        turns: accum.turns,
        lastAction: accum.lastAction,
        lastActivityAt: Date.now(),
      });
    } catch {
      /* best-effort */
    }
  };

  // Killing the `opencode run --server` CLIENT does not stop the server-side session — it stays
  // `running` and its tools keep executing (measured 2.0.25: a file written 40 s after the
  // kill). So once the client is gone, on EVERY exit path (clean exit, idle kill, cancel,
  // shutdown, a throwing reader), the session is interrupted on the server. `interrupted:false`
  // on an already-idle session is a harmless no-op; failures are logged, never thrown.
  const interruptServerSession = async (): Promise<void> => {
    await proc.exited.catch(() => undefined);
    const sessionId = accum.sessionId;
    if (!sessionId) return;
    const result = await (ctx.interrupt ?? interruptOpencodeSession)(sessionId);
    runnerLogger()[result.ok ? "info" : "warn"](
      {
        event: "session.opencode_interrupt",
        project: ctx.cwd,
        ...errCtx,
        sessionId,
        interrupted: result.interrupted,
        ok: result.ok,
        error: result.error,
      },
      "opencode server session interrupt after client exit",
    );
  };

  try {
    try {
      // A trailing partial line (no newline before EOF) is dropped, as before.
      await readTrimmedLines(proc.stdout, {
        onChunk: () => {
          lastChunkAt = Date.now();
        },
        onLine: (line) => {
          const ev = parseOpencodeLine(line);
          if (!ev) return;
          eventCount++;
          const prevSessionId = accum.sessionId;
          accum = reduceOpencodeEvent(accum, ev);
          if (!prevSessionId && accum.sessionId) {
            announceOpencodeSessionId(accum.sessionId, {
              iuOpenaiBase: ctx.iuOpenaiBase,
              model: ctx.model,
              backend: ctx.backend,
              tool: ctx.tool,
              onSessionId: ctx.onSessionId,
            });
          }
          ctx.turnsRef.current = accum.turns;
          emitActivity();
        },
      });
    } finally {
      clearInterval(idleWatchdog);
      if (heartbeatHandle !== null) clearInterval(heartbeatHandle);
      // A reader.read() throw (or any other exception escaping the loop above) must not
      // orphan the child — same guarantee the idle watchdog's own kill() gives a wedged
      // worker, just triggered by a different failure shape. No-op if already exited.
      forceKill();
    }
  } catch (err) {
    // Not awaited: the reader failure is already propagating, and the interrupt waits for the
    // (possibly SIGKILL-escalated) client exit first — it must not delay the rejection.
    void interruptServerSession().catch(() => undefined);
    throw err;
  }

  const stderrTrimmed = (await stderrPromise).trim();
  const exitCode = await proc.exited;
  // See this function's own doc comment for why this is cleared HERE, not earlier.
  if (sigkillTimer !== null) clearTimeout(sigkillTimer);
  await interruptServerSession();

  return { accum, eventCount, exitCode, stderrTrimmed, killReason, idleMsAtKill };
}

// ── Attempt runner ─────────────────────────────────────────────────────────────

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
  interrupt?: typeof interruptOpencodeSession;
  spawn?: (argv: string[], options: Parameters<typeof Bun.spawn>[1]) => OpencodeSubprocess;
}

/** One opencode session launch — the harness counterpart to `runSessionAttempt`'s claude
 *  path, called from there when `resolveHarness()` resolves `"opencode"`. Always the PRIMARY
 *  attempt: a forced (fallback) attempt is never opencode (`resolveHarness`'s doc comment),
 *  so `ctx.backend` here is always the route's own primary backend (`iu` for both AGENT_OC
 *  tiers) — there is no analogue of claude's `forced` parameter to thread through. */
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

  // No caller passes this for a dispatch route — opencode's permission profile
  // (the `agw-*` agents, opencode-server.ts) has no per-tool-name allow/deny surface to extend,
  // unlike claude's `--disallowedTools`. A caller that starts doing so needs this module updated, not a
  // silently-ignored option.
  if (extraDisallowedTools && extraDisallowedTools.length > 0) {
    throw new Error(
      "runOpencodeAttempt: extraDisallowedTools is not supported on the opencode harness",
    );
  }
  // Both are claude-CLI-specific (`--setting-sources`, `--mcp-config`) and have no opencode
  // equivalent this module wires up — silently dropping them used to be invisible. dispatch
  // always passes `settingSources: "user,project"`, so this fires on every ordinary opencode
  // dispatch call; that is expected, not a bug to chase — it's just now visible at debug
  // level instead of nowhere.
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

  // A shared server takes no per-run env: the worker's shell inherits the SERVER's. Refuse
  // loudly rather than let a caller's variable silently vanish — except the research
  // credentials, dropped on purpose (keys only in the log, never values).
  const { dropped: droppedExtraEnv } = assertExtraEnvCarriedByServer(extraEnv);
  if (droppedExtraEnv.length > 0) {
    runnerLogger().warn(
      { event: "session.opencode_extra_env_dropped", tool, keys: droppedExtraEnv },
      "extraEnv dropped on the opencode harness — research validation is unavailable until per-session env",
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

  // Never spawn against a dead endpoint or server: `opencode run` would retry them forever.
  // Both are classified as transport failures (connection-class text, no `iuConfigError` — the
  // breaker must count them), so the retry ladder and the Max fallback treat them as such.
  const refuseSpawn = (reason: string, error: string, logMessage: string): SessionResult<T> => {
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
    return refuseSpawn(
      "opencode_preflight_failed",
      `IU endpoint unreachable before opencode spawn: ${probe.reason}`,
      "IU endpoint unreachable — opencode not spawned",
    );
  }

  // The shared server must be up AND the pinned build; the text carries a connection-class
  // token whatever the cause (down, wrong version, rejected password) so a wrong-version server
  // falls through to the Max fallback instead of failing the episode outright.
  const server = await (deps.serverStatus ?? getOpencodeServerStatus)();
  if (!server.ok) {
    return refuseSpawn(
      "opencode_server_unavailable",
      `opencode server unavailable before spawn (transport-class, fetch failed): ${server.error ?? "not ok"}`,
      "opencode server unavailable — opencode not spawned",
    );
  }
  const password = (deps.password ?? readServerPassword)();

  const env = buildOpencodeEnv({ tool, cwd, password });

  const finalPrompt = jsonSchema ? appendJsonSchemaInstruction(prompt, jsonSchema) : prompt;
  const argv = buildOpencodeArgs({
    bin: OPENCODE_BIN,
    url: opencodeServerUrl(),
    readOnly,
    model,
    variant,
    resumeSessionId,
    prompt: finalPrompt,
  });

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
    "session spawn (opencode)",
  );

  const startMs = performance.now();
  if (jobId !== undefined && isCancelled?.(jobId)) throw new SessionCancelledError(jobId);
  const proc = deps.spawn
    ? deps.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env })
    : Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env });
  const streamResult = await runOpencodeProcessLifecycle(proc, {
    jobId,
    cwd,
    model,
    backend,
    tool,
    iuOpenaiBase,
    onSessionId,
    onActivity,
    onProgress,
    turnsRef,
    interrupt: deps.interrupt,
  });
  let { accum, exitCode, stderrTrimmed } = streamResult;
  const { killReason, idleMsAtKill } = streamResult;

  // The runtime IU key and the server password are live env vars inside a session with Bash
  // access (the server's env, which every worker shell inherits) — redact both out of everything
  // that could echo them back BEFORE any of it is used to build an error message or gets
  // parsed/returned as data. See `redactSecret`'s doc comment.
  const redact = (text: string): string => redactSecret(redactSecret(text, iuKey), password);
  accum = {
    ...accum,
    lastAssistantText: redact(accum.lastAssistantText),
    errorMessage: accum.errorMessage ? redact(accum.errorMessage) : accum.errorMessage,
  };
  stderrTrimmed = redact(stderrTrimmed);

  const durationMs = Math.round(performance.now() - startMs);
  const costUsd = computeOpencodeCostUsd(accum, model);
  const costFields = {
    costUsd,
    inputTokens: accum.inputTokens,
    outputTokens: accum.outputTokens,
    // Named `thinkingTokens` here (not `reasoningTokens`) to match the claude path's own
    // attribution field name (session-runner.ts's `costFields`) — one consistent column for
    // usage-tracker regardless of which harness produced the row.
    thinkingTokens: accum.reasoningTokens,
    cacheReadTokens: accum.cacheReadTokens,
    cacheWriteTokens: accum.cacheWriteTokens,
  };
  const emitAttribution = (
    outcome: "ok" | "error" | "timeout_idle",
    extras: Record<string, unknown> = {},
  ) =>
    writeAttribution({
      sessionId: sessionUuid,
      tool: tool ?? "unknown",
      project: cwd,
      model,
      backend,
      harness: "opencode",
      tsStart,
      tsEnd: new Date().toISOString(),
      outcome,
      durationMs,
      turns: accum.turns,
      ...costFields,
      ...extras,
    });

  if (killReason) {
    emitAttribution("timeout_idle", { killReason, idleMsAtKill });
    const error = `Session timed out — idle ${idleMsAtKill}ms with no stdout (budget ${IDLE_TIMEOUT_MS}ms)`;
    return { ok: false, error, classificationText: error, hadApiRetry: false, backend, model };
  }

  if (exitCode !== 0) {
    emitAttribution("error", { exitCode });
    // opencode's own `error` event, when present, is CLI/tool-sourced same standing as
    // claude's `envelope.errors[]` — safe to classify. Otherwise fall back to a generic
    // message carrying the stderr tail, same shape as claude's `classifyExitFailure`'s
    // no-envelope branch.
    const error = accum.sawErrorEvent
      ? `opencode error: ${accum.errorMessage ?? "unknown"}`
      : `opencode exited with code ${exitCode}${stderrTrimmed ? `. stderr: ${stderrTrimmed.slice(-2000)}` : ""}`;
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      backend,
      model,
      ...(accum.lastAssistantText
        ? { noOutput: true as const, rawText: accum.lastAssistantText }
        : {}),
    };
  }

  // exit 0 is NOT success on its own — a real `type: "error"` event (tested,
  // tests/fixtures/opencode-events-error.jsonl) can still exit 0, so that check is preserved.
  // It is NOT gated on a terminal `step_finish(reason: "stop")`: opencode 2.x does not emit one
  // under `--standalone` (measured 2026-10-11 on 2.0.25 — the process exits right after the
  // final assistant text and the terminal event is dropped almost every run), so requiring it
  // failed every successful dispatch. A clean exit carrying a final assistant message and no
  // error event is the completion signal; a genuinely truncated/interrupted run exits non-zero,
  // trips the idle watchdog, or emits an `error` event — all handled above.
  // `noOutput: true` on both branches below so `isSalvageable` (dispatch.ts) still gets one
  // retry out of a partial `lastAssistantText`, same as every other "ran but didn't finish
  // cleanly" shape this module produces.
  if (accum.sawErrorEvent) {
    emitAttribution("error", { reason: "error_event" });
    const error = `opencode error: ${accum.errorMessage ?? "unknown"}`;
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: accum.lastAssistantText || undefined,
      backend,
      model,
    };
  }

  if (!accum.lastAssistantText) {
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

  if (!accum.endedOnText) {
    emitAttribution("error", { reason: "truncated_stream" });
    const error = "opencode stream ended on a tool call, not a final assistant message";
    return {
      ok: false,
      error,
      classificationText: error,
      hadApiRetry: false,
      noOutput: true,
      rawText: accum.lastAssistantText,
      backend,
      model,
    };
  }

  if (accum.usageIncomplete) {
    runnerLogger().debug(
      { event: "session.opencode_usage_incomplete", project: cwd, ...errCtx, turns: accum.turns },
      "opencode final-turn usage not accounted (no terminal step_finish) — cost/tokens understated",
    );
  }

  const parsed = extractJson<T>(accum.lastAssistantText);
  if (parsed === undefined) {
    emitAttribution("error", { reason: "json_parse" });
    return unclassifiedOutputFailure<T>(
      `final message is not valid JSON: ${accum.lastAssistantText.slice(0, 500)}`,
      accum.lastAssistantText,
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
    emitAttribution("ok", { usageIncomplete: accum.usageIncomplete });
    return { ok: true, data: v.value, backend, model };
  }

  emitAttribution("ok", { usageIncomplete: accum.usageIncomplete });
  return { ok: true, data: parsed as T, backend, model };
}
