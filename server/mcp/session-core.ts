// ── Session core — the leaf both harnesses build on ─────────────────────────────────
//
// `session-runner.ts` (claude -p, the retry/fallback loop) and `opencode-runner.ts` (OpenCode
// sessions over HTTP) used to import each other. Everything the harness needs from the runner's
// chassis lives here instead and this module imports from neither: the session option/result
// types, the error classes, the live-worker registry that `POST /api/jobs/:id/cancel` and a drain
// act on (subprocesses and remote OpenCode sessions), the session ledger port, the attribution /
// `session_env` sinks and JSON recovery. `session-runner.ts` re-exports what its existing
// importers (store.ts, handlers, tests) resolve through it.

import { appendFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { logger as mcpLogger } from "./logger.ts";
import { appLogger } from "../logger.ts";
import { processKind } from "../lib/process-context.ts";
import { IDLE_TIMEOUT_MS } from "../lib/idle-timeout.ts";
import { usageLane } from "./worker-shared.ts";
import type { Backend, Harness, ToolRoute } from "../lib/routing.ts";

/** Pure idle-watchdog predicate: has it been at least `idleTimeoutMs` since the last stdout
 *  chunk (or spawn, if none arrived yet)? Extracted out of the `setInterval` callback below so
 *  the "no separate ceiling" behavior — a session that keeps producing output can run past any
 *  fixed wall-clock duration without ever being killed — is unit-testable without spawning a
 *  real subprocess or driving a live timer. */
export function isIdleTimedOut(
  now: number,
  lastActivityAt: number,
  idleTimeoutMs: number = IDLE_TIMEOUT_MS,
): boolean {
  return now - lastActivityAt >= idleTimeoutMs;
}

/**
 * Pick the logger for the process actually running this call, not the one that happened to
 * import this module first.
 *
 * `runSession` is shared: job handlers (check/review/dispatch/overview/narrative) call it from
 * inside the always-on HTTP server process, while `otel`'s tool handler calls it directly from
 * the MCP stdio process — a module-level `import { logger } from "./logger.ts"` tagged every
 * line `source: "mcp"` regardless of which one actually ran. A post-mortem on 8 `session.timeout`
 * entries had to join them against `jobs.db` by timestamp instead of filtering on `source`,
 * which is the bug this resolves. See `process-context.ts` for why this must be read per call
 * rather than captured once at module load.
 */
export function runnerLogger(): typeof appLogger {
  return processKind() === "app" ? appLogger : mcpLogger;
}

const CLAUDE_LOG_DIR = join(homedir(), ".claude", "logs");

/** Pure: the `data` object of a `session_env` line — split out of `writeSessionEnv` so the
 *  `lane`/`harness` shape is unit-testable without touching `~/.claude/logs`. */
export function sessionEnvRecord(
  sessionId: string,
  baseUrl: string | null,
  model: string,
  backend: Backend,
  tool: string | undefined,
  harness: Harness,
  account?: string,
): {
  session: string;
  base_url: string | null;
  model: string;
  backend: Backend;
  lane: string;
  harness: Harness;
  account?: string;
} {
  return {
    session: sessionId,
    base_url: baseUrl,
    model,
    backend,
    lane: usageLane(tool),
    harness,
    ...(account ? { account } : {}),
  };
}

/** Mirror dotfiles' SessionStart hook: record the worker's base_url keyed by its
 * transcript sessionId so usage-tracker's classifier (base_url present → "iu",
 * null/missing → "max") tags the run correctly. Called for both the "iu" backend
 * (real base_url) and the "max" backend (explicit null — see the max branch below
 * for why null is written rather than skipped). Idempotent — safe if the hook also
 * fires. Never throws.
 *
 * `lane` (`usageLane(tool)`, e.g. `"agent-gateway:dispatch"`) and `harness` are the only
 * per-worker signal that survives to usage-tracker at all: every worker runs with
 * `disableAllHooks: true` (WORKER_SETTINGS), so dotfiles' own SessionStart hook never
 * fires inside one — this sidecar record is the sole source, not a mirror of a redundant
 * one, despite the doc-comment framing above predating that fact. Exported so
 * `opencode-runner.ts` writes the identical shape (`harness: "opencode"`) rather than a
 * second, drifting sink usage-tracker would need its own collector for.
 *
 * `account` is the Claude Max account id (`claude-account account`) the worker ran under;
 * omitted for IU and for a picker failure. */
export function writeSessionEnv(
  sessionId: string,
  baseUrl: string | null,
  model: string,
  backend: Backend,
  tool: string | undefined,
  harness: Harness,
  account?: string,
): void {
  try {
    mkdirSync(CLAUDE_LOG_DIR, { recursive: true });
    const now = new Date().toISOString();
    const line =
      JSON.stringify({
        ts: now,
        src: "agent-gateway",
        event: "session_env",
        level: "info",
        data: sessionEnvRecord(sessionId, baseUrl, model, backend, tool, harness, account),
      }) + "\n";
    appendFileSync(join(CLAUDE_LOG_DIR, `${now.slice(0, 10)}.jsonl`), line);
  } catch {
    /* never throw from telemetry */
  }
}

// Per-session attribution log. Each runSession invocation appends one record
// describing tool / cwd / time window — usage-tracker joins individual worker
// requests to it by ts ∈ [tsStart, tsEnd], so token rows get tagged with which
// agent-gateway tool (check/review/…) caused them.
// Format: NDJSON, one record per session, written on completion.
// `AGENT_GATEWAY_SESSIONS_LOG` overrides the path (tests/setup.ts points it at a temp dir),
// resolved per call so a test can set it late.
const attributionLog = (): string =>
  process.env.AGENT_GATEWAY_SESSIONS_LOG ??
  join(homedir(), ".local", "share", "usage-tracker", "agent-gateway-sessions.jsonl");

/** Exported so `opencode-runner.ts` appends to the SAME attribution log/sink under its own
 *  `harness: "opencode"` record shape, rather than a parallel file usage-tracker would need
 *  a second collector for. */
export function writeAttribution(record: Record<string, unknown>): void {
  try {
    const log = attributionLog();
    mkdirSync(dirname(log), { recursive: true });
    appendFileSync(log, JSON.stringify(record) + "\n", "utf-8");
  } catch {
    // Attribution is best-effort — never break a session over a log write.
  }
}

// ── Types ──────────────────────────────────────────────────────────────────────

export interface SessionOptions<T = unknown> {
  cwd: string;
  prompt: string;
  /** The tool's `{ model, backend, fallback }` from `routeFor()` in
   *  `server/lib/routing.ts` — the only source of a worker's model and auth path. */
  route: ToolRoute;
  /** Per-call model override on top of `route.model` (a job's `model` param). Applied
   *  via `withModel`: a gateway id forces the backend to `iu` since Max cannot serve it. */
  model?: string;
  jsonSchema?: Record<string, unknown>;
  /**
   * `--setting-sources` value. Default "project" (repo CLAUDE.md only) keeps the
   * system prompt small — most one-shot workers don't need the global rule set.
   * Use "user,project" for tools that benefit from the global code-style/typescript
   * rules (review).
   */
  settingSources?: string;
  /**
   * Read-only worker: removes Edit/Write/NotebookEdit from the tool set via
   * `--disallowedTools`. Workers are eager and will "helpfully" edit files under
   * `--dangerously-skip-permissions` (Kimi once auto-fixed lint during a `check`),
   * so check/review/dispatch must opt in. Bash stays available (needed to run
   * validators / curl / git), so prompts must also instruct "report only".
   *
   * NB `--allowedTools` does NOT work here and was the original, silently-broken
   * implementation — skip-permissions bypasses the permission system an allowlist
   * feeds, so Write stayed available. See the flag construction below.
   */
  readOnly?: boolean;
  /**
   * Check workers only: lets an OpenCode `readOnly` session also run the repo's build/test
   * runners (make, bun, uv, pytest, …) — the `agw-check` permission profile. Edits stay
   * denied. No effect on the claude harness, whose Bash is open under `readOnly` already.
   */
  runsChecks?: boolean;
  /**
   * The worker answers from the prompt alone: every tool denied. On the claude harness the caller
   * expresses it with `extraDisallowedTools` (which is why that option may accompany this one on
   * OpenCode); on OpenCode it selects the `agw-toolless` permission profile.
   */
  toolless?: boolean;
  /**
   * Let a timeout AFTER first output still move onto the fallback lane. Default false:
   * a worker that already produced turns may have half-done its work (dispatch,
   * excalidraw), so only a silent timeout switches. Callers whose worker has no side
   * effects (overview: every tool disallowed; check: report-only, Write/Edit disallowed)
   * opt in — measured 2026-09-07, glm-5.3-flash produced 2 assistant turns on overview
   * and then hung to the 240 s cap, and the job failed with no Haiku attempt.
   */
  retryAfterOutput?: boolean;
  /**
   * Per-call idle-watchdog budget (ms): the session is killed only after this long with no
   * stdout chunk, defaulting to `IDLE_TIMEOUT_MS` (5 min). Callers whose worker legitimately
   * goes quiet for longer than that raise it. `check` does: a single Bash step buffers its
   * command output and emits no stdout for the step's whole duration, so the default
   * 5-minute session window would kill the session before the worker's own per-step idle
   * window (up to 600s for a test step) could ever apply. Still an idle watchdog, never a
   * wall-clock ceiling — a session that keeps producing output runs past it.
   */
  idleTimeoutMs?: number;
  /**
   * MCP servers to expose to the worker, in `claude --mcp-config`'s `mcpServers` shape
   * (e.g. `{ hyperdx: { type: "http", url, headers } }`). Merged under `--strict-mcp-config`,
   * so this is the *entire* server set the worker sees — never the repo's own `.mcp.json`.
   * Omitted (default): the worker gets `{"mcpServers": {}}`, i.e. none, matching every
   * caller before this field existed.
   */
  mcpServers?: Record<string, unknown>;
  /**
   * Extra tool names appended to the `readOnly` disallow list (e.g. an MCP server's
   * mutating tools — `mcp__hyperdx__clickstack_save_*`). Ignored when `readOnly` is false;
   * a writable session has no disallow list to append to. Tool names must be exact, per
   * the same caveat as the base `readOnly` list below — no glob support confirmed for
   * MCP-namespaced tool names.
   */
  extraDisallowedTools?: string[];
  /** Extra env vars merged into the worker (e.g. RESEARCH_GATEWAY_URL/TOKEN for review). */
  extraEnv?: Record<string, string>;
  /**
   * Tool name for usage attribution — e.g. "check", "review".
   * Written to the agent-gateway-sessions.jsonl attribution log so
   * usage-tracker can tag worker requests back to the agent-gateway tool that caused
   * them. Optional but every job handler should set it.
   */
  tool?: string;
  /**
   * The async job this session runs inside, if any (`job.id` from `jobs/store.ts`). Carried
   * through purely for log correlation — every error-path log below includes it alongside
   * `tool`/`model`/`backend` so a failure line is self-describing instead of needing a
   * timestamp join against `jobs.db`. Absent for a session that isn't job-backed (e.g. `otel`,
   * which runs synchronously inside the MCP tool call).
   */
  jobId?: string;
  /**
   * Reports whether `jobId` has a pending `POST /api/jobs/:id/cancel` request. Injected
   * dependency, same shape as `ShutdownDeps` in `server/lib/shutdown.ts` — this module must
   * not import `server/jobs/store.ts` directly (store.ts already imports
   * `terminateSessionsForJob` from here; the reverse import would be a cycle). The
   * executor/handler path (`server/jobs/executor.ts` down through each handler's `runSession`
   * call) supplies `store.ts`'s `isCancelRequested` here. Absent for a session that isn't
   * job-backed, same as `jobId`. */
  isCancelled?: (jobId: string) => boolean;
  /** Called every 15s while the subprocess runs. Use to send MCP progress notifications and reset client timeout. */
  onProgress?: (progress: number, total: number, message: string) => void;
  /**
   * Called on every stream-json event from the worker (turn complete, tool call,
   * tool result). Lets the job layer persist live progress — most importantly
   * `lastActivityAt`, from which callers derive idle time to tell a working
   * session from a wedged one. Fire-and-forget; errors are swallowed by the runner.
   */
  onActivity?: (progress: SessionProgress) => void;
  /**
   * Optional output validator. Some worker models ignore `--json-schema` and
   * emit prose-fenced JSON that `extractJson` casts WITHOUT type-checking, so
   * schema drift (e.g. a field of the wrong type) otherwise slips through to the
   * MCP `outputSchema` boundary and fails the call opaquely. When provided, the
   * extracted data (from `structured_output` or the result fence) is validated
   * here first — a failure becomes a clear `{ ok: false }`. Build from the tool's
   * Zod schema via `zodValidator(MY_OUTPUT)`.
   */
  validate?: (data: unknown) => { ok: true; value: T } | { ok: false; error: string };
  /**
   * Resume a previously-started worker transcript instead of spawning a fresh session —
   * `buildSessionArgs` emits `--resume <id>` alongside `-p <prompt>` (verified against
   * `.claude/skills/claude-cli/references/cli-flags.md`'s Sessions table: `--resume`/`-r` takes
   * a UUID and carries no documented restriction against `-p`). `prompt` in this mode should be
   * a short continuation nudge, not the original brief — the resumed transcript already has it.
   *
   * This is narrower than the vendored skill's own "No `--resume` for HITL" guidance
   * (`.claude/skills/claude-cli/SKILL.md`), which is about a human-in-the-loop workflow
   * re-entering a session across separate turns and warns that a killed mid-execution resume
   * can corrupt it. The caller here (`server/jobs/handlers/dispatch.ts`'s boot-recovery resume,
   * `server/jobs/store.ts`'s `recover()`) is a NARROWER, owner-decided case: a worker killed by
   * this process's own restart (crash, SIGKILL, `FORCE=1`, launchd's `ExitTimeOut`), resumed
   * exactly once from the last recorded transcript id in the same worktree it left on disk. The
   * corruption risk the skill warns about is real and not eliminated by that narrowing — flagged
   * here rather than silently assumed away.
   */
  resumeSessionId?: string;
  /**
   * Fired once, the instant the worker's real transcript session id is first observed (the
   * same moment `writeSessionEnv`'s sidecar log fires) — before the session finishes. Lets a
   * job handler persist it immediately (`server/jobs/store.ts`'s `updateJobSessionId`), so a
   * process killed moments later still leaves a resumable id on the job row instead of only
   * learning it from a `SessionResult` that a kill prevents from ever being returned.
   * Fire-and-forget; errors are swallowed by the runner, same contract as `onActivity`.
   */
  onSessionId?: (sessionId: string) => void;
  /**
   * Stable name of this call within its job, for a job that runs several OpenCode sessions
   * (review's angles, a JSON-only retry's second session). With a `jobId` the runner records the
   * OpenCode session it creates in the job's session ledger (`SessionLedger`, `job_sessions`)
   * under this key, and a re-run of the job after a drain re-attaches that session instead of
   * creating one — by the same live / finished / cut-off state logic as `resumeSessionId`. The
   * ROW decides, not a counter: a failed attempt drops its row, so at most one row per key
   * survives and it is the session to continue; a second call under the key in the same process
   * is a handler-level retry and starts fresh (see `runSession`).
   *
   * Detachability: a drain detaches an OpenCode session (rather than interrupting it) only when
   * the caller can hand it back — this key, or `onSessionId` persisting the id on the job row
   * (dispatch). Without either, the session is interrupted on drain as before. Ignored by the
   * claude harness and without a `jobId`.
   */
  reattachKey?: string;
  /**
   * The prompt for a re-attached OpenCode session or a claude `--resume` that already has history
   * — a short continuation nudge. `prompt` stays the full original brief: a re-attached session
   * with no message at all (detached between its creation and its first prompt) is sent that
   * instead. Unset: `prompt` is used either way.
   */
  resumePrompt?: string;
}

export interface SessionResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
  /**
   * True when the session completed cleanly (exit 0, not is_error, not timed out)
   * but produced nothing parseable — neither `structured_output`, a JSON `result`,
   * nor recoverable assistant text. The work may still be on disk: a file-editing
   * handler could treat this as a cue to reconcile against `git`
   * rather than reporting an outright failure. Never set on timeout/exit/is_error.
   */
  noOutput?: boolean;
  /**
   * The worker's raw final text when output could not be parsed/validated into `T`
   * (set alongside `noOutput`; the non-zero-exit branch also sets it, with or without
   * `noOutput`). Untruncated, unlike the truncated copy in `error`.
   * Lets a handler salvage a degraded-but-non-empty result (e.g. a synthesis that
   * emitted prose instead of JSON) instead of discarding minutes of work.
   */
  rawText?: string;
  /** Total attempts made, including the first. 1 unless a transient transport
   *  failure was retried — see `isRetryableSessionError`. */
  attempts?: number;
  /** True if an earlier attempt failed and was retried before this result. */
  retried?: boolean;
  /** Backend the attempt that produced this result actually ran on — set
   *  regardless of ok/error, so a job handler or the retry loop can tell which
   *  auth path a given result came from (relevant once a quota fallback can
   *  switch mid-session-launch from "max" to "iu"). */
  backend?: Backend;
  /** Model the attempt actually ran on — differs from the route's primary after a
   *  fixed-model fallback (check's glm-5.3-flash → claude-haiku-4-5 on Max). */
  model?: string;
  /** The attempt never spawned a worker: IU credentials could not be resolved. The
   *  reverse fallback treats this like an IU transport failure, without a same-backend
   *  retry first (there is nothing to retry). */
  iuConfigError?: boolean;
  /** Transport/provider-sourced text ONLY (stderr, the runner's own constructed error
   *  message) — never model-generated stdout. Feeds `isQuotaError` classification;
   *  `error` stays the full human-readable text regardless. Unset on branches whose
   *  only text is the worker's own output (an unparseable `result`, a schema-validation
   *  failure) — those must never quota-classify. See `isQuotaError`'s doc comment. */
  classificationText?: string;
  /** The runner observed a stream-json `system`/`api_retry` event during this attempt —
   *  a structured signal that the CLI itself retried after a provider-side 429/529.
   *  Checked ahead of the `classificationText` regex in `planNextAttempt`. */
  hadApiRetry?: boolean;
  /** The result event's own `api_error_status` — set when the failure is the gateway/API
   *  refusing the request outright (bad model id, cost-ceiling denial) rather than a
   *  model-produced error. See the doc comment above `apiErrorStatus` in
   *  `runSessionAttempt` for the measured stream shape: this failure produces one
   *  synthetic assistant "turn" that is Claude Code's own error text, so `noOutputYet`
   *  does not catch it — `planNextAttempt` must gate on this field instead. Unset on the
   *  timeout path and on `!envelope` (no result event ever arrived to carry it). */
  apiErrorStatus?: number;
  /** Set by `runSession` (never by an attempt) when a write-tier session failed with an IU
   *  server error AFTER producing output and the Max fallback was therefore NOT run — its
   *  worktree may already hold half-applied edits. See `planNextAttempt` rule 3. */
  fallbackWithheld?: "write-tier-after-output";
}

/** Live progress snapshot emitted via `onActivity` as stream-json events arrive. */
export interface SessionProgress {
  /** Assistant turns observed so far. */
  turns: number;
  /** Short label of the most recent worker action, e.g. "Edit store.ts" or "Bash: bun test". */
  lastAction: string;
  /** Epoch ms of the last stream event — `Date.now() - lastActivityAt` is idle time. */
  lastActivityAt: number;
}

// Workers sometimes ignore --json-schema and emit text that contains a ```json
// fence followed by prose commentary. The strict "whole string must be JSON"
// parser then rejects what is semantically a successful result. This extractor
// tries, in order:
//   1. parse the whole trimmed string
//   2. parse the contents of the first ```json fenced block
//   3. parse the contents of the first ``` (unlabeled) fenced block
//   4. brace-scan for the first top-level {...} that parses (skipping strings)
// Returns the parsed value, or undefined if nothing parses.

/** Exported so `opencode-runner.ts` reuses the identical extraction — opencode has no
 *  `--json-schema` flag, so its final assistant text is always run through this rather than
 *  a CLI-parsed envelope. */
export function extractJson<T>(raw: string): T | undefined {
  const text = raw.trim();

  const tryParse = (s: string): T | undefined => {
    try {
      return JSON.parse(s) as T;
    } catch {
      return undefined;
    }
  };

  let parsed = tryParse(text);
  if (parsed !== undefined) return parsed;

  const jsonFence = text.match(/```json\s*\n([\s\S]*?)\n```/);
  if (jsonFence) {
    parsed = tryParse(jsonFence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  const anyFence = text.match(/```[a-zA-Z]*\s*\n([\s\S]*?)\n```/);
  if (anyFence) {
    parsed = tryParse(anyFence[1].trim());
    if (parsed !== undefined) return parsed;
  }

  // Brace scan: find the first balanced {...} that parses, respecting strings.
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        parsed = tryParse(text.slice(start, i + 1));
        if (parsed !== undefined) return parsed;
        return undefined;
      }
    }
  }
  return undefined;
}

/** Shared failure shape for the schema-validation and JSON-parse branches — both are
 *  "the session completed at the API level, but its own output didn't parse/validate",
 *  so neither ever sets `classificationText` (the text is the model's own stdout, not
 *  transport-sourced). `hadApiRetry` still propagates: it describes the attempt's
 *  transport behavior, independent of how the attempt's own output turned out — it
 *  used to be silently dropped on both branches while present on every other failure
 *  return. Pure and exported purely so that propagation has direct unit coverage. */
export function unclassifiedOutputFailure<T = unknown>(
  error: string,
  rawText: string,
  hadApiRetry: boolean,
  backend: Backend,
  model: string,
): SessionResult<T> {
  return { ok: false, error, noOutput: true, rawText, hadApiRetry, backend, model };
}

/** Worker subprocesses alive in THIS process, mapped to the job they belong to (`undefined`
 *  for a session run outside the job system, e.g. review's adversary text call). The HTTP
 *  server's SIGTERM handler (`server/index.ts`) reads the count to decide how long to wait,
 *  then terminates what is left so a `make reload` never orphans a `claude -p` that keeps
 *  editing a worktree the boot sweep is about to delete. */
interface ActiveProcEntry {
  jobId: string | undefined;
  /** Whether the child leads its own process group (`Bun.spawn` `detached: true` → `setsid`),
   *  so a negative-PID signal reaches the whole group instead of only the leader. Only the
   *  deterministic `make check`/`fallow audit` steps (`server/jobs/handlers/check.ts`) spawn
   *  detached; `claude -p`, opencode and ocr all share the server's group and are signalled
   *  directly. */
  detached: boolean;
}
const activeProcs = new Map<ReturnType<typeof Bun.spawn>, ActiveProcEntry>();

/** A worker with no local process: an OpenCode session driven over HTTP on the shared server
 *  (opencode-runner.ts). Cancel and drain reach it through `stop` — which interrupts the
 *  server-side session — exactly as they reach a subprocess through a signal. */
interface ActiveRemoteEntry {
  jobId: string | undefined;
  stop: (reason: RemoteStopReason) => void;
  /** A drain DETACHES this session (leaves it running on the shared server for the next boot to
   *  re-attach) instead of interrupting it: true for every session run under a job. */
  detachable: boolean;
  /** `stop("drain")` has been delivered (the session detached). */
  detached: boolean;
}

/** Why a remote worker is being stopped: `cancel` is an owner's `job_cancel` (the session must
 *  die), `drain` is this process going away (a session run under a job keeps running on the
 *  server and is re-attached by the next boot). */
export type RemoteStopReason = "cancel" | "drain";
const activeRemote = new Set<ActiveRemoteEntry>();

/** Jobs that had an OpenCode session detached by THIS process's drain, and whether a drain has
 *  begun at all. Process-lifetime state (a drain ends in an exit): it keeps those jobs out of the
 *  drain's blocker count after their session's drive loop has already unregistered, and makes a
 *  session that starts mid-drain detach before it ever creates anything. */
const detachedJobIds = new Set<string>();
let sessionDrainBegun = false;

/** Whether a drain may detach this OpenCode session: it runs under a job AND the caller can hand
 *  it back after the restart (`SessionOptions.reattachKey` or `onSessionId`). */
export function canDetachSession(
  opts: Pick<SessionOptions<unknown>, "jobId" | "reattachKey" | "onSessionId">,
): boolean {
  return (
    opts.jobId !== undefined && (opts.reattachKey !== undefined || opts.onSessionId !== undefined)
  );
}

export function activeSessionCount(): number {
  return activeProcs.size + activeRemote.size;
}

/** True once a drain has begun (`detachRemoteSessions`): an OpenCode attempt under a job must not
 *  start a new session — it detaches at once and the next boot starts it. */
export function isSessionDraining(): boolean {
  return sessionDrainBegun;
}

/** Register a remote (HTTP-driven) worker so `POST /api/jobs/:id/cancel` and a drain can stop it.
 *  `detachable` (`canDetachSession`) = a drain leaves it running for the next boot to re-attach.
 *  Returns the untrack fn; the caller runs it in a `finally` once the session is over. A
 *  detachable session registered after the drain began is detached on the spot. */
export function trackExternalSession(
  jobId: string | undefined,
  stop: (reason: RemoteStopReason) => void,
  detachable: boolean,
): () => void {
  const entry: ActiveRemoteEntry = { jobId, stop, detachable, detached: false };
  activeRemote.add(entry);
  if (sessionDrainBegun && detachable) detachEntry(entry);
  return () => activeRemote.delete(entry);
}

function detachEntry(entry: ActiveRemoteEntry): void {
  entry.detached = true;
  if (entry.jobId !== undefined) {
    detachedJobIds.add(entry.jobId);
    // Durable at once — including for a session that registers after the drain began, which the
    // drain's start-of-drain pass never saw.
    sessionLedger?.markDetached(entry.jobId);
  }
  entry.stop("drain");
}

/** Detach every detachable OpenCode session (`canDetachSession`): stop being awaited, keep running
 *  on the shared server, re-attached by the next boot. Called at the START of a drain, so the
 *  drain waits only for work that cannot be detached. Each detach marks its job durably through
 *  the store port (`SessionLedger.markDetached`). Idempotent. Returns the ids of every job with a
 *  detached session (this and any earlier call). */
export function detachRemoteSessions(): string[] {
  sessionDrainBegun = true;
  for (const entry of activeRemote) {
    if (entry.detachable && !entry.detached) detachEntry(entry);
  }
  return [...detachedJobIds];
}

/** Jobs a drain need not wait for: those with a detachable OpenCode session (running, or already
 *  detached by this drain) and NO other live work. A live subprocess under the same job id — a
 *  `claude -p` angle next to the OpenCode ones, OCR, a check step — or a non-detachable remote
 *  session keeps the job a blocker: the drain waits for it. */
export function detachableJobIds(): Set<string> {
  const ids = new Set(detachedJobIds);
  for (const entry of activeRemote) {
    if (entry.detachable && entry.jobId !== undefined) ids.add(entry.jobId);
  }
  for (const entry of activeRemote) {
    if (!entry.detachable && entry.jobId !== undefined) ids.delete(entry.jobId);
  }
  for (const [proc, entry] of activeProcs) {
    if (proc.exitCode === null && entry.jobId !== undefined) ids.delete(entry.jobId);
  }
  return ids;
}

/** Signal one registered subprocess the way its spawn shape requires. A detached child leads
 *  its own process group (`setsid`), so `proc.kill` would reach only the leader and orphan a
 *  recipe's backgrounded children (e.g. `check:\n\t@sleep 300 &`) — `process.kill(-pid, …)`
 *  reaches the whole group. A non-detached child must NOT be group-killed: `-proc.pid` is not a
 *  process group there, and could coincidentally match some other group id. */
function killRegisteredProc(
  proc: ReturnType<typeof Bun.spawn>,
  entry: ActiveProcEntry,
  signal: "SIGTERM" | "SIGKILL",
): void {
  if (entry.detached) {
    try {
      process.kill(-proc.pid, signal);
    } catch {
      /* the process group is already gone */
    }
  } else {
    proc.kill(signal);
  }
}

/** Register a non-`runSession` child process (e.g. `server/lib/ocr.ts`'s `ocr review` spawn)
 *  into the same `activeProcs` map worker sessions use, so `POST /api/jobs/:id/cancel`
 *  (`terminateSessionsForJob`) and a drain (`terminateActiveSessions`) can kill it too — the
 *  same reason `runSessionAttempt` registers its own `Bun.spawn` result below. Pass `detached:
 *  true` when the child was spawned with `Bun.spawn(..., { detached: true })` so the two kill
 *  paths group-kill it. Returns an untrack fn; the caller runs it in a `finally` once the
 *  process has exited (mirroring `void proc.exited.finally(() => activeProcs.delete(proc))`
 *  below, which `runSession`'s own spawn gets for free but an external caller must do itself). */
export function trackExternalProc(
  proc: ReturnType<typeof Bun.spawn>,
  jobId: string | undefined,
  detached = false,
): () => void {
  activeProcs.set(proc, { jobId, detached });
  return () => activeProcs.delete(proc);
}

/** Test-only: register an already-constructed fake "proc" into `activeProcs` under a given
 *  jobId, so `terminateSessionsForJob`/`terminateActiveSessions` can be exercised without
 *  spawning a real `claude -p` subprocess. The caller only needs to satisfy the `exitCode`/
 *  `kill`/`pid` shape those two functions actually read — cast at the call site. */
export function __registerProcForTests(
  proc: ReturnType<typeof Bun.spawn>,
  jobId: string | undefined,
  detached = false,
): void {
  activeProcs.set(proc, { jobId, detached });
}

export function __resetActiveProcsForTests(): void {
  activeProcs.clear();
  activeRemote.clear();
  detachedJobIds.clear();
  sessionDrainBegun = false;
}

/** Kill every active worker subprocess and return the ids of the jobs they belonged to (a
 *  process with no `jobId` — a session run outside the job system — is silently dropped, not
 *  emitted as `undefined`). server/jobs/store.ts's `markDrainKilled` records exactly these ids
 *  before the killed subprocess's `execute()` catch can run, so a job genuinely terminated by
 *  this call can be told apart from an unrelated failure landing in the same drain window —
 *  see the comment on `execute()`'s catch block. */
export function terminateActiveSessions(): string[] {
  const jobIds: string[] = [];
  for (const [proc, entry] of activeProcs) {
    if (proc.exitCode === null) {
      killRegisteredProc(proc, entry, "SIGTERM");
      if (entry.jobId !== undefined) jobIds.push(entry.jobId);
    }
  }
  // A session detached at the start of the drain (`detachRemoteSessions`) is not killed here:
  // only a remote worker nothing can re-attach (no job) is still stopped — and interrupted.
  for (const entry of activeRemote) {
    if (entry.detached) continue;
    entry.stop("drain");
    if (entry.jobId !== undefined) jobIds.push(entry.jobId);
  }
  return jobIds;
}

/** The per-job counterpart to `terminateActiveSessions()`'s "kill everything" (drain): signals
 *  only the worker subprocess(es) registered for ONE job (`POST /api/jobs/:id/cancel` →
 *  `server/jobs/store.ts`'s `cancelJob`). Same two-stage SIGTERM → 5s → SIGKILL escalation as
 *  the per-attempt timeout above (:1166-1186), but self-contained here since a cancel isn't
 *  tied to that attempt's own timeout clock. Returns whether anything was actually signalled —
 *  false if the job's worker had already exited (or the job never reached `running` with a
 *  registered proc, e.g. it was still queued). */
export function terminateSessionsForJob(jobId: string): boolean {
  let signalled = false;
  for (const [proc, entry] of activeProcs) {
    if (entry.jobId !== jobId || proc.exitCode !== null) continue;
    signalled = true;
    killRegisteredProc(proc, entry, "SIGTERM");
    setTimeout(() => {
      if (proc.exitCode === null) killRegisteredProc(proc, entry, "SIGKILL");
    }, 5000);
  }
  for (const entry of activeRemote) {
    if (entry.jobId !== jobId) continue;
    signalled = true;
    entry.stop("cancel");
  }
  if (!signalled) {
    // Not necessarily a bug: the job may still be `pending` (no proc yet — `cancelJob` handles
    // that case without ever calling this), or its worker may have exited in the gap between
    // `cancelJob` reading `running` and this call. Worth a warn either way — a cancel that
    // signalled nothing depends entirely on `runSession`'s own cancel check (top-of-loop / after
    // an attempt) to actually stop the job, rather than the SIGTERM doing it.
    runnerLogger().warn(
      { event: "session.cancel_no_proc", jobId },
      "cancel requested but no live worker subprocess was registered for this job",
    );
  }
  return signalled;
}

/** Thrown by `runSession`'s retry loop when a `POST /api/jobs/:id/cancel` was observed for this
 *  job — distinguishable from an ordinary session failure so it is never retried, never falls
 *  back to another backend, and callers that inspect the error type (none currently do;
 *  `server/jobs/store.ts`'s `execute()` catch instead consults the job row's persisted
 *  `cancelRequestedAt`, which is authoritative regardless of how a handler wraps this error) can
 *  tell the two apart. */
export class SessionCancelledError extends Error {
  constructor(jobId: string) {
    super(`session cancelled by request (job ${jobId})`);
    this.name = "SessionCancelledError";
  }
}

/** Thrown by an OpenCode session run under a job when a drain detached it: the session keeps
 *  running on the server and the next boot re-attaches it (dispatch: the job row's `session_id`
 *  via `recover()`; any other tool: the job's session ledger). The handler must leave everything
 *  the session is using (its worktree) in place and must not count this as a failure, retry it
 *  or fall back — this is not a failure and not a cancel. */
export class SessionDetachedError extends Error {
  constructor(jobId: string | undefined) {
    super(`session detached for a restart (job ${jobId ?? "unknown"}) — re-attached on boot`);
    this.name = "SessionDetachedError";
  }
}

// ── Session ledger (multi-session jobs) ───────────────────────────────────────────────
//
// A job that runs several OpenCode sessions (review: one per angle) cannot hand a single
// `resumeSessionId` back to its re-run. Each session created under a `reattachKey` is recorded
// in the job's ledger instead (server/jobs/store.ts, `job_sessions`), and `runOpencodeAttempt`
// looks the key up before it creates anything. Injected rather than imported: store.ts already
// imports this module, so the reverse import would be a cycle (same reason as `isCancelled`).

export interface SessionLedgerRow {
  sessionId: string;
  /** The session's usage was already attributed (`writeAttribution`) by an earlier attempt, so a
   *  re-attach reads the result without writing a second usage row. */
  settled: boolean;
}

export interface SessionLedger {
  /** A drain detached a session of this job: mark the job for budget-free requeue on boot. */
  markDetached(jobId: string): void;
  get(jobId: string, key: string): SessionLedgerRow | undefined;
  put(jobId: string, key: string, sessionId: string): void;
  settle(jobId: string, key: string): void;
  drop(jobId: string, key: string): void;
}

let sessionLedger: SessionLedger | null = null;

export function setSessionLedger(ledger: SessionLedger | null): void {
  sessionLedger = ledger;
}

export function getSessionLedger(): SessionLedger | null {
  return sessionLedger;
}

/** How many `runSession` calls this process has made per (job, `reattachKey`). Only to tell a
 *  handler-level retry (a second call under the key in the SAME process: the first call's result
 *  was rejected) from the first call of a re-run after a restart — the first call re-attaches
 *  whatever row survived, a repeat starts fresh. It is never part of the key, so a restart cannot
 *  shift keys: the persisted row, not a counter, names the session. */
const ledgerCalls = new Map<string, number>();

export function nextLedgerCall(jobId: string, reattachKey: string): number {
  const id = `${jobId}\u0000${reattachKey}`;
  const call = (ledgerCalls.get(id) ?? 0) + 1;
  ledgerCalls.set(id, call);
  return call;
}

/** Drop a finished job's call counters (store.ts, when the job leaves `running`). */
export function forgetLedgerCalls(jobId: string): void {
  for (const id of ledgerCalls.keys()) {
    if (id.startsWith(`${jobId}\u0000`)) ledgerCalls.delete(id);
  }
}
