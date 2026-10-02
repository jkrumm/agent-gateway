// Per-repo lease for implement episodes — at most one per repo, across every caller.
//
// Two implement episodes in one repo race in ways a worktree does not isolate: in-place ones
// interleave edits in the same live checkout (and the snapshot attribution cannot tell them
// apart), and worktree ones share `.git` — two revisions of one branch, or a `update_pr`
// rebase against a branch an episode is about to push, would clobber each other. The HTTP
// server is a single process (launchd guarantees it), so a module-level map is exact for
// every caller that reaches it — MCP, CLI, warden all submit through `POST /api/jobs`. A
// crash clears it with the process. Keyed on the canonical repo root so two paths to the
// same repo contend correctly.

import { realpathSync } from "node:fs";
import { appLogger as logger } from "../logger.ts";

const leases = new Map<string, string>();

/** Take the repo's lease, or report the job that holds it. */
export function tryAcquireRepoLease(
  cwd: string,
  jobId: string,
): { ok: true } | { ok: false; holder: string } {
  const key = realpathSync(cwd);
  const holder = leases.get(key);
  if (holder !== undefined) return { ok: false, holder };
  leases.set(key, jobId);
  return { ok: true };
}

/** Best effort by construction: called from a `finally`, where a throw would replace
 *  whatever the try/catch already decided to report. Falls back to the raw `cwd` string as
 *  the map key if the path can no longer be resolved (the repo was moved or deleted
 *  mid-episode) — better to leak one stale map entry than to throw out of a cleanup path. */
export function releaseRepoLease(cwd: string): void {
  let key: string;
  try {
    key = realpathSync(cwd);
  } catch (err) {
    logger.warn(
      { event: "dispatch.repo_lease_release_failed", project: cwd, error: String(err) },
      "could not resolve the real path to release the repo lease — falling back to the raw cwd",
    );
    key = cwd;
  }
  leases.delete(key);
}

/** The refusal text every lease holder conflict reports, so callers read one phrasing. */
export function repoLeaseRefusal(holder: string, tool = "dispatch"): string {
  return (
    `${tool} refused: an implement episode is already running in this repo (job ${holder}) — ` +
    `implement episodes serialize per repo because their edits and pushes would interleave. ` +
    `Re-submit once it finishes.`
  );
}
