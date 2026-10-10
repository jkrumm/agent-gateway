import { Elysia, t } from "elysia";
import { cancelJob, createJob, getJob, listJobs, queueStats } from "../jobs/store.ts";
import { isJobTool } from "../jobs/types.ts";
import { resolveDispatchTarget } from "../lib/dispatch-policy.ts";
import { computeHealth } from "../lib/health.ts";
import { dispatchSubmitRefusal } from "../jobs/handlers/dispatch.ts";
import { validateModel } from "../lib/routing.ts";

// HTTP surface for the async job system. The MCP tools are thin clients of these
// routes (server/mcp/job-client.ts). Hosted in the always-on HTTP server so jobs
// outlive the ephemeral MCP process. See server/jobs/store.ts.

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
      if (typeof model === "string" && !validateModel(model).ok) {
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
      if (body.tool === "dispatch") {
        const refusal = await dispatchSubmitRefusal((body.params ?? {}) as Record<string, unknown>);
        if (refusal) {
          set.status = 400;
          return { ok: false as const, error: refusal };
        }
      }
      const job = createJob(body.tool, body.params ?? {});
      return { ok: true as const, job };
    },
    {
      body: t.Object({
        tool: t.String(),
        params: t.Optional(t.Record(t.String(), t.Unknown())),
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
  // (server/lib/health.ts, kuma-push.ts): a degraded route pages there, not via `ok`.
  .get("/health", () => computeHealth())

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
  });
