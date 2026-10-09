import { Elysia, t } from "elysia";
import { cancelJob, createJob, getJob, listJobs, queueStats } from "../jobs/store.ts";
import { isJobTool } from "../jobs/types.ts";
import { DEFAULT_DISPATCH_TIER, resolveDispatchTarget } from "../lib/dispatch-policy.ts";
import { computeHealth } from "../lib/health.ts";
import { validateModel } from "../lib/routing.ts";

// HTTP surface for the async job system. The MCP tools are thin clients of these
// routes (server/mcp/job-client.ts). Hosted in the always-on HTTP server so jobs
// outlive the ephemeral MCP process. See server/jobs/store.ts.

export const jobsRoutes = new Elysia({ prefix: "/api/jobs" })
  // Submit a job — returns immediately with the job id. Execution starts when a
  // concurrency slot is free; poll GET /:id (or the MCP job_wait) for the result.
  .post(
    "/",
    ({ body, set }) => {
      if (!isJobTool(body.tool)) {
        set.status = 400;
        return { ok: false as const, error: `unknown tool: ${body.tool}` };
      }
      // Same check `runDispatch` runs (server/jobs/handlers/dispatch.ts), applied here too so
      // a refused repo/tier never even creates a job row. The handler's copy stays regardless —
      // the MCP client, and any future submitter, must not be able to reach execution by
      // skipping this route. Only engages for `dispatch`, and only when `cwd`/`tier` parse as
      // plain strings — anything else falls through to the handler's own zod validation, whose
      // "invalid params" error shape is out of scope here.
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
      if (body.tool === "dispatch") {
        const params = (body.params ?? {}) as Record<string, unknown>;
        const cwd = params.cwd;
        const tierRaw = "tier" in params ? params.tier : DEFAULT_DISPATCH_TIER;
        if (typeof cwd === "string" && typeof tierRaw === "string") {
          const decision = resolveDispatchTarget({ cwd, tier: tierRaw });
          if (!decision.ok) {
            set.status = 400;
            return { ok: false as const, error: `dispatch refused: ${decision.reason}` };
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
