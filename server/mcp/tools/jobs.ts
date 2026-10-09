import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isTerminal, type JobStatus, type JobView } from "../../jobs/types.ts";
import { getJobStatus, httpReachable, requestJobCancel, HTTP_DOWN_MESSAGE } from "../job-client.ts";
import { mcpProgressCallback } from "../session-runner.ts";

// Polling tools for the async job system. The four long tools return a jobId;
// these retrieve the eventual result. `job_wait` is the primary primitive — a
// server-friendly long-poll that blocks (with progress heartbeats) until the job
// finishes or the wait window elapses, so the agent never tight-loops and the
// MCP client timeout never trips.

const POLL_INTERVAL_MS = 2000;
// Default stays under the MCP client's 60 s out-of-the-box request timeout, so a caller that
// passes nothing behaves exactly as before and never eats a hard transport abort.
export const DEFAULT_WAIT_MS = 50_000;
// The ceiling an explicit `maxWaitMs` may reach. Raising it only pays off when this server's
// entry in `~/.claude.json` carries a matching `timeout` — the client aborts the request on
// its own clock, and an abort is a hard failure where the 50 s default would have returned a
// clean `stillRunning`. The two numbers are one setting in two files; move them together.
// Worth moving: measured over 91 jobs, a `review` (p50 345 s, max 685 s) costs nine wait
// rounds at 50 s — nine model turns spent asking "done yet?" — against one at this ceiling.
// 29 min leaves a minute of headroom under a 30 min client timeout, matching `dispatch`'s own
// longest job timeout.
export const MAX_WAIT_MS = 29 * 60 * 1000;

/** Pure clamp for the `maxWaitMs` input: missing → `DEFAULT_WAIT_MS`, floored at 1000 ms (a
 *  sub-second budget would just thrash the poll loop below for no benefit), ceiled at
 *  `MAX_WAIT_MS`. Exported so the boundary — raised from 55 s to 29 min in the same change —
 *  is tested directly instead of only through a live MCP call. */
export function clampMaxWaitMs(maxWaitMs: number | undefined): number {
  return Math.min(Math.max(maxWaitMs ?? DEFAULT_WAIT_MS, 1000), MAX_WAIT_MS);
}

const JOB_STATE_OUTPUT = z.object({
  jobId: z.string(),
  tool: z.string(),
  status: z
    .enum(["pending", "running", "done", "failed", "interrupted", "cancelled"])
    .describe(
      "pending=queued, running=executing, done/failed/interrupted/cancelled=terminal. cancelled means job_cancel (or POST /api/jobs/:id/cancel) was called — not a failure.",
    ),
  stillRunning: z
    .boolean()
    .describe(
      "True while not terminal. If true after job_wait, call job_wait again with the same jobId.",
    ),
  elapsedMs: z.number().describe("Wall time so far (running) or total (terminal)."),
  idleMs: z
    .number()
    .nullable()
    .describe(
      "ms since the worker's last activity (stream event), while running; null otherwise. THE wedge signal: a large/growing idleMs during 'running' means the session may be stuck rather than working — peek at the repo (git status) instead of waiting indefinitely. A long single tool call (e.g. a slow test run) can briefly raise it legitimately, so judge by trend.",
    ),
  turns: z
    .number()
    .nullable()
    .describe("Assistant turns the worker has taken so far. Null before the first event."),
  lastAction: z
    .string()
    .nullable()
    .describe(
      "Most recent worker action, e.g. 'Edit store.ts' or 'Bash: bun test'. Null before the first event.",
    ),
  result: z
    .unknown()
    .nullable()
    .describe("The tool's structured output. Present only when status is 'done'."),
  error: z
    .string()
    .nullable()
    .describe(
      "Failure reason. Present when status is 'failed' or 'interrupted'; also set to 'cancelled by request' when status is 'cancelled'.",
    ),
});

type JobState = z.infer<typeof JOB_STATE_OUTPUT>;

// job_cancel answers with the job's state plus what the cancel actually did, because "accepted"
// means two different things: a pending job is already `cancelled`, a running one only has the
// request recorded (`cancel_requested`, status still `running` until its worker exits).
const JOB_CANCEL_OUTPUT = JOB_STATE_OUTPUT.extend({
  outcome: z
    .enum(["cancelled", "cancel_requested", "already_terminal"])
    .describe(
      "cancelled=pending job cancelled immediately. cancel_requested=running job: SIGTERM sent best-effort, status stays 'running' until the worker exits (poll job_wait). already_terminal=nothing to cancel, the job had already finished — `status` is its final state.",
    ),
  cancelRequested: z
    .boolean()
    .describe("True once a cancel has been accepted for this job (running jobs), else false."),
});

type JobCancelState = z.infer<typeof JOB_CANCEL_OUTPUT>;

function toState(view: JobView): JobState {
  return {
    jobId: view.id,
    tool: view.tool,
    status: view.status,
    stillRunning: !isTerminal(view.status),
    elapsedMs: view.elapsedMs,
    idleMs: view.idleMs,
    turns: view.progress?.turns ?? null,
    lastAction: view.progress?.lastAction ?? null,
    result: view.result,
    error: view.error,
  };
}

function toCancelState(view: JobView, outcome: JobCancelState["outcome"]): JobCancelState {
  return { ...toState(view), outcome, cancelRequested: view.cancelRequested ?? false };
}

function notFound(jobId: string) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: `Job not found: ${jobId}` }) },
    ],
    isError: true as const,
  };
}

function down() {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: HTTP_DOWN_MESSAGE }) }],
    isError: true as const,
  };
}

function ok(state: JobState) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    structuredContent: state as unknown as Record<string, unknown>,
  };
}

function okCancel(state: JobCancelState) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(state) }],
    structuredContent: state as unknown as Record<string, unknown>,
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ── job_status — one-shot poll ─────────────────────────────────────────────────
export function registerJobStatusTool(server: McpServer): void {
  server.registerTool(
    "job_status",
    {
      title: "Job Status (one-shot)",
      description: `Return the current state of a background job by id, without waiting. Prefer job_wait when you actually want the result — this is for a quick non-blocking peek (e.g. checking on a long review while doing other work).

OUTPUT: \`status\` (pending/running/done/failed/interrupted/cancelled) and \`stillRunning\`. While running, \`turns\`/\`lastAction\` show live worker activity and \`idleMs\` is ms since its last event — a large/growing \`idleMs\` is the wedge signal (peek at git status rather than waiting forever). When status is "done", \`result\` holds the tool's structured output; when "failed"/"interrupted"/"cancelled", \`error\` explains why. To stop a job, call job_cancel.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/review."),
      },
      outputSchema: JOB_STATE_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId }) => {
      if (!(await httpReachable())) return down();
      try {
        const view = await getJobStatus(jobId);
        return view ? ok(toState(view)) : notFound(jobId);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}

// ── job_wait — long-poll until terminal or window elapses ──────────────────────
export function registerJobWaitTool(server: McpServer): void {
  server.registerTool(
    "job_wait",
    {
      title: "Wait for Job",
      description: `Block until a background job finishes (or the wait window elapses), then return its state. This is the normal way to consume check/review: submit → job_wait → use result.

BEHAVIOR: polls internally and sends progress heartbeats, so it is safe for long jobs. Waits ~50s per call by default; if the job is still running when the window elapses it returns \`stillRunning: true\` — call job_wait again with the same jobId (loop until stillRunning is false). You may also do other work between calls.
LONG JOBS: pass an explicit \`maxWaitMs\` to wait in ONE call instead of looping — a review (typically 5-11 min) otherwise costs ~9 round trips. Only do this if this server's \`~/.claude.json\` entry sets a \`timeout\` at least as large; without it the client aborts at 60s and the abort is a hard error, unlike the clean \`stillRunning\` the default returns.
OUTPUT: when \`status\` is "done", \`result\` holds the tool's structured output; "failed"/"interrupted"/"cancelled" set \`error\`. To stop a job, call job_cancel.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/review."),
        maxWaitMs: z
          .number()
          .optional()
          .describe(
            `Max time to block this call, in ms. Default ${DEFAULT_WAIT_MS} (safe with any client), capped at ${MAX_WAIT_MS}. Values above the default require a matching \`timeout\` on this server's ~/.claude.json entry.`,
          ),
      },
      outputSchema: JOB_STATE_OUTPUT.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ jobId, maxWaitMs }, extra) => {
      if (!(await httpReachable())) return down();

      const budget = clampMaxWaitMs(maxWaitMs);
      const deadline = Date.now() + budget;
      const onProgress = mcpProgressCallback(extra);

      try {
        let view = await getJobStatus(jobId);
        if (!view) return notFound(jobId);

        let tick = 0;
        while (!isTerminal(view.status as JobStatus) && Date.now() < deadline) {
          await sleep(POLL_INTERVAL_MS);
          tick++;
          const action = view.progress?.lastAction ? ` — ${view.progress.lastAction}` : "";
          onProgress?.(
            tick,
            0,
            `Job ${view.tool} ${view.status} (${Math.round(view.elapsedMs / 1000)}s elapsed)${action}`,
          );
          view = (await getJobStatus(jobId)) ?? view;
        }
        return ok(toState(view));
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}

// ── job_cancel — stop one job ──────────────────────────────────────────────────
export function registerJobCancelTool(server: McpServer): void {
  server.registerTool(
    "job_cancel",
    {
      title: "Cancel Job",
      description: `Cancel one background job by id (the HTTP \`POST /api/jobs/:id/cancel\`). A pending job is cancelled immediately; a running job gets a best-effort SIGTERM to its worker and lands "cancelled" once the worker exits. A cancel is not a failure and is never counted toward the failed-jobs health signal.

WHEN TO CALL: a job you submitted is no longer wanted, is wedged (large and growing \`idleMs\` in job_status), or was submitted with the wrong brief. Do not call it to "check" a job — use job_status.
SIDE EFFECTS: terminates the job's worker process. Work the worker already did is not rolled back — a dispatch \`implement\` episode may already have changed its worktree or pushed a branch. A job that is already finished cannot be cancelled. Calling it again on the same running job is a no-op (no second signal).
OUTPUT: the job's state (same fields as job_status) plus \`outcome\`: "cancelled" (pending job, terminal now), "cancel_requested" (running job: \`status\` is still "running" and \`cancelRequested\` true — call job_wait to see it land "cancelled"), or "already_terminal" (nothing cancelled; \`status\` is the job's final state). An unknown id is an error.`,
      inputSchema: {
        jobId: z.string().describe("The job id returned by check/review/dispatch/..."),
      },
      outputSchema: JOB_CANCEL_OUTPUT.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ jobId }) => {
      if (!(await httpReachable())) return down();
      try {
        const result = await requestJobCancel(jobId);
        if (result.kind === "not_found") return notFound(jobId);
        if (result.kind === "accepted") {
          const outcome = result.job.status === "cancelled" ? "cancelled" : "cancel_requested";
          return okCancel(toCancelState(result.job, outcome));
        }
        const view = await getJobStatus(jobId);
        return view ? okCancel(toCancelState(view, "already_terminal")) : notFound(jobId);
      } catch (err) {
        return {
          content: [{ type: "text", text: JSON.stringify({ error: String(err) }) }],
          isError: true,
        };
      }
    },
  );
}
