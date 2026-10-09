import type { JobTool, JobView } from "../jobs/types.ts";

// Thin HTTP client used by the MCP tools to talk to the always-on HTTP server's
// job API (server/routes/jobs.ts). The MCP process is ephemeral (dies on /mcp
// disconnect); the HTTP server (LaunchAgent :7705) is durable and hosts the jobs.

const PORT = process.env.PORT ?? "7705";
// 127.0.0.1, not `localhost`: the server binds loopback v4 only (server/index.ts), and a
// resolver that hands out ::1 first would turn every submit into a connection refusal.
const BASE = process.env.AGENT_GATEWAY_HTTP_URL ?? `http://127.0.0.1:${PORT}`;

/** Liveness probe so a down HTTP server produces a clear error, not an opaque fetch failure. */
export async function httpReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

export const HTTP_DOWN_MESSAGE =
  `agent-gateway HTTP server unreachable at ${BASE}. It hosts the job queue and runs via LaunchAgent — ` +
  `check 'tail -f ~/Library/Logs/agent-gateway.err' and run 'make reload' in ~/SourceRoot/agent-gateway.`;

interface JobEnvelope {
  ok: boolean;
  job?: JobView;
  error?: string;
}

/** Submit a job. Returns the created job view (status usually "pending"/"running"). */
export async function submitJob(tool: JobTool, params: Record<string, unknown>): Promise<JobView> {
  const res = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tool, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const data = (await res.json()) as JobEnvelope;
  if (!res.ok || !data.ok || !data.job) {
    throw new Error(data.error ?? `job submit failed with status ${res.status}`);
  }
  return data.job;
}

/** Fetch a job's current state. Returns null if the id is unknown (404). */
export async function getJobStatus(jobId: string): Promise<JobView | null> {
  const res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return null;
  const data = (await res.json()) as JobEnvelope;
  if (!res.ok || !data.ok || !data.job) {
    throw new Error(data.error ?? `job status fetch failed with status ${res.status}`);
  }
  return data.job;
}

/** Outcome of `POST /api/jobs/:id/cancel`. 404 and 409 are expected answers, not transport
 *  failures, so they are values; anything else unexpected throws like the other helpers. */
export type CancelResult =
  | { kind: "accepted"; job: JobView }
  | { kind: "not_found" }
  | { kind: "already_terminal"; error: string };

/** Ask the server to cancel one job. A `pending` job comes back already `cancelled`; a
 *  `running` one comes back still `running` with `cancelRequested: true` (best-effort SIGTERM,
 *  the `cancelled` transition lands once the worker exits). */
export async function requestJobCancel(jobId: string): Promise<CancelResult> {
  const res = await fetch(`${BASE}/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return { kind: "not_found" };
  const data = (await res.json()) as JobEnvelope;
  if (res.status === 409)
    return { kind: "already_terminal", error: data.error ?? "job already terminal" };
  if (!res.ok || !data.ok || !data.job) {
    throw new Error(data.error ?? `job cancel failed with status ${res.status}`);
  }
  return { kind: "accepted", job: data.job };
}
