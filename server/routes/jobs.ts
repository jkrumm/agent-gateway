import { statSync } from "node:fs";
import { Elysia, t } from "elysia";
import { CALLER_RULE, isValidCaller } from "../lib/caller.ts";
import { cancelJob, createJob, getJob, listJobs, queueStats } from "../jobs/store.ts";
import { isJobTool, type JobTool } from "../jobs/types.ts";
import { resolveDispatchTarget } from "../lib/dispatch-policy.ts";
import { computeHealth } from "../lib/health.ts";
import { dispatchSubmitRefusal } from "../jobs/handlers/dispatch.ts";
import { proseSubmitRefusal } from "../jobs/handlers/prose.ts";
import { isDecisionModel } from "../lib/decision.ts";
import { validateModel } from "../lib/routing.ts";
import { steerJob } from "../lib/steer.ts";

// HTTP surface for the async job system. The MCP tools are thin clients of these
// routes (server/mcp/job-client.ts). Hosted in the always-on HTTP server so jobs
// outlive the ephemeral MCP process. See server/jobs/store.ts.

// Everything knowable without running the episode that a tool's handler also checks: `dispatch`
// (the repo/tier policy, malformed params, ...) and `prose` (a same-lab writer/reviewer pair, a
// non-anthropic writer, an anthropic reviewer — see proseSubmitRefusal) refuse here, before a job
// row exists.
async function toolSubmitRefusal(tool: JobTool, params: unknown): Promise<string | null> {
  // A `cwd` that does not exist is the caller's mistake (a deleted worktree, a typo), not a job
  // failure: as a job it would count toward `failedLastHour` and could fail a correct deploy's
  // verify (measured 2026-10-19: 14 replayed reviews of deleted worktrees in one second rolled
  // a deploy back). Every handler that takes `cwd` repeats this check.
  const cwd = (params as Record<string, unknown> | undefined)?.cwd;
  if (typeof cwd === "string" && !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
    return `${tool} refused: directory not found: ${cwd}`;
  if (tool === "dispatch") return dispatchSubmitRefusal((params ?? {}) as Record<string, unknown>);
  if (tool === "prose") return proseSubmitRefusal(params);
  return null;
}

export const jobsRoutes = new Elysia({ prefix: "/api/jobs" })
  // Submit a job — returns immediately with the job id. Execution starts when a
  // concurrency slot is free (and, for an implement-class job, the repo's lease — a busy repo
  // keeps it `pending` with `queuedBehind`); poll GET /:id (or the MCP job_wait) for the result.
  .post(
    "/",
    async ({ body, set }) => {
      if (!isJobTool(body.tool)) {
        set.status = 400;
        return { ok: false as const, error: `unknown tool: ${body.tool}` };
      }
      // The submitting consumer's slug, for per-consumer spend attribution. Envelope-level (not
      // a tool param), so it applies to every tool without each handler's schema knowing it.
      if (body.caller !== undefined && !isValidCaller(body.caller)) {
        set.status = 400;
        return { ok: false as const, error: `${body.tool} refused: ${CALLER_RULE}` };
      }
      // `update_pr` takes the same repo-policy gate as an implement dispatch, so a refused repo
      // never creates a job row. (`dispatch` is gated by `dispatchSubmitRefusal` below, which
      // owns its policy check.) The handlers repeat each check — the MCP client, and any future
      // submitter, must not be able to reach execution by skipping this route. Only engages when
      // `cwd` parses as a plain string; anything else falls through to the handler's own zod.
      if (body.tool === "update_pr") {
        const cwd = (body.params as Record<string, unknown> | undefined)?.cwd;
        if (typeof cwd === "string") {
          const decision = resolveDispatchTarget({ cwd, tier: "implement" });
          if (!decision.ok) {
            set.status = 400;
            return { ok: false as const, error: `update_pr refused: ${decision.reason}` };
          }
        }
      }
      // A per-job `model` that `withModel` would silently ignore (unknown / unverified id)
      // means the episode runs on the route's default while the caller believes otherwise —
      // refuse loudly here instead, for every tool that takes one (dispatch, review, overview,
      // narrative). Non-string values fall through to the handler's zod.
      const model = (body.params as Record<string, unknown> | undefined)?.model;
      // `decide` names a decision model, which the chat registry does not list; its handler
      // validates the id against `DECISION_MODELS` instead.
      const isDecide = body.tool === "decide";
      if (
        typeof model === "string" &&
        (isDecide
          ? !isDecisionModel(model)
          : !validateModel(model, { singleShot: body.tool === "prose" }).ok)
      ) {
        set.status = 400;
        return {
          ok: false as const,
          error: `${body.tool} refused: model ${model} is not a verified registry model`,
        };
      }
      // Everything knowable without running the episode (the repo/tier policy, malformed
      // params, in-place and sensitive combinations, revisionOf shape, branch/prTitle validity,
      // a branch name already taken) refuses here too, so the caller gets a 400 now instead of a
      // job that is accepted and fails a moment later. The handler repeats each check.
      const refusal = await toolSubmitRefusal(body.tool, body.params);
      if (refusal) {
        set.status = 400;
        return { ok: false as const, error: refusal };
      }
      const job = createJob(body.tool, body.params ?? {}, body.caller);
      return { ok: true as const, job };
    },
    {
      body: t.Object({
        tool: t.String(),
        params: t.Optional(t.Record(t.String(), t.Unknown())),
        caller: t.Optional(t.String()),
      }),
    },
  )

  // List recent jobs + queue depth (for monitoring / a future dashboard panel).
  .get("/", () => ({ ok: true as const, jobs: listJobs(), stats: queueStats() }))

  // Queue health for the devhost heartbeat: `ok` is false when ≥3 jobs failed in the last
  // hour or the oldest pending job has waited >15 min. Static route, so it is registered
  // before `/:id` — never resolved as a job named "health".
  //
  // `routeStreaks`/`degradedRoutes`/`warnings` are reported, never enforced on `ok`, same as
  // `backendFallbacks` — `ok` stays computed from `evaluateJobHealth` alone. The additive
  // `pageable`/`pageReason` carry the "should this page" verdict the Kuma heartbeat uses
  // (server/lib/health.ts, kuma-push.ts): a degraded route pages there, not via `ok`. So does
  // `opencodeServer` (the shared OpenCode server's status) when it is not ok.
  .get("/health", async () => computeHealth())

  // Poll a single job's state. `job.status` terminal ⇒ `result` or `error` is set.
  .get("/:id", ({ params, set }) => {
    const job = getJob(params.id);
    if (!job) {
      set.status = 404;
      return { ok: false as const, error: "job not found" };
    }
    return { ok: true as const, job };
  })

  // Cancel one job (warden Wave 5.3's kill surface for a single item, distinct from
  // POST /api/shutdown's process-wide drain). A different method + suffix on the same `/:id`
  // segment, so the "static routes before /:id" ordering rule above doesn't apply here.
  .post("/:id/cancel", ({ params, set }) => {
    const result = cancelJob(params.id);
    if (!result.ok) {
      set.status = result.status;
      return { ok: false as const, error: result.error };
    }
    return { ok: true as const, job: result.job };
  })

  // Steer a running dispatch episode: posts the text into its live OpenCode session
  // (`delivery: "steer"`) so new facts reach the agent loop without a kill-and-restart.
  // 409 = nothing live to steer (not running, not a dispatch, no OpenCode session, between turns).
  .post(
    "/:id/steer",
    async ({ params, body, set }) => {
      const result = await steerJob(params.id, body.text);
      if (!result.ok) {
        set.status = result.status;
        return { ok: false as const, error: result.error };
      }
      return { ok: true as const, jobId: params.id, sessionId: result.sessionId };
    },
    { body: t.Object({ text: t.String() }) },
  );
