// Steering a running episode: `POST /api/jobs/:id/steer` posts `delivery: "steer"` into the
// episode's OpenCode session, so new facts (a CI failure, a review finding, an owner answer)
// reach the live agent loop instead of costing a kill-and-restart. Only a running dispatch on
// the OpenCode harness has a steerable session; everything else answers 409 with the reason.

import { jobSteerTarget } from "../jobs/store.ts";
import { createOpencodeClient, type OpencodeClient } from "../mcp/opencode-client.ts";
import { appLogger as logger } from "../logger.ts";

export const STEER_MAX_CHARS = 20_000;

/** Framed so the worker reads the text as new information from its caller, not as a fresh task. */
const STEER_PREFIX =
  "Update from the caller while you are working — treat it as new facts for the task you already have, then continue:\n\n";

export type SteerResult =
  | { ok: true; sessionId: string }
  | { ok: false; status: 400 | 404 | 409 | 502; error: string };

export async function steerJob(
  jobId: string,
  text: string,
  client: OpencodeClient = createOpencodeClient(),
): Promise<SteerResult> {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, status: 400, error: "steer text is empty" };
  if (trimmed.length > STEER_MAX_CHARS) {
    return { ok: false, status: 400, error: `steer text exceeds ${STEER_MAX_CHARS} characters` };
  }
  const target = jobSteerTarget(jobId);
  if (!target) return { ok: false, status: 404, error: "job not found" };
  if (target.status !== "running") {
    return {
      ok: false,
      status: 409,
      error: `job is ${target.status}, not running — nothing to steer`,
    };
  }
  if (target.tool !== "dispatch") {
    return {
      ok: false,
      status: 409,
      error: `only a running dispatch can be steered (job is ${target.tool})`,
    };
  }
  const sessionId = target.sessionId;
  if (!sessionId?.startsWith("ses_")) {
    return {
      ok: false,
      status: 409,
      error: "the episode has no live OpenCode session yet (or runs on the claude harness)",
    };
  }
  try {
    if (!(await client.active()).includes(sessionId)) {
      return { ok: false, status: 409, error: "the episode's session is not running a turn" };
    }
    await client.prompt(sessionId, { text: STEER_PREFIX + trimmed, delivery: "steer" });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    logger.warn({ event: "job.steer_failed", jobId, sessionId, error }, "steer failed");
    return { ok: false, status: 502, error: `could not reach the episode's session: ${error}` };
  }
  logger.info(
    { event: "job.steer", jobId, sessionId, chars: trimmed.length },
    "steered a running episode",
  );
  return { ok: true, sessionId };
}
