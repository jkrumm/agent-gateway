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
//
// Who takes it: the job store, at PROMOTION (`server/jobs/store.ts`'s `promote()`), for every
// job whose params say it needs one (`repoLeaseCwdFor`) — a job whose repo is busy stays
// `pending` (FIFO per repo) instead of starting and failing. The handlers' own acquisition is
// the same call made again with the same job id, which is a no-op re-entry (`reentrant`), so a
// direct caller (no store) is still protected and a stored job is never refused by itself.

import { realpathSync } from "node:fs";
import { appLogger as logger } from "../logger.ts";

const leases = new Map<string, string>();
/** The exact key each held `cwd` was acquired under, so release deletes precisely that entry
 *  even if the path no longer resolves (or now resolves elsewhere) by then. */
const keyByCwd = new Map<string, string>();

/** Take the repo's lease, or report the job that holds it. Fails closed: throws when the
 *  path cannot be resolved, since a raw-path key could let two aliases of one repo both in.
 *  Re-entrant for the same `jobId`: the holder asking again (the store took it at promotion,
 *  the handler asks again) gets `{ ok: true, reentrant: true }` and must NOT release it. */
export function tryAcquireRepoLease(
  cwd: string,
  jobId: string,
): { ok: true; reentrant: boolean } | { ok: false; holder: string } {
  const key = realpathSync(cwd);
  const holder = leases.get(key);
  if (holder === jobId) return { ok: true, reentrant: true };
  if (holder !== undefined) return { ok: false, holder };
  leases.set(key, jobId);
  keyByCwd.set(cwd, key);
  return { ok: true, reentrant: false };
}

/** The job holding the lease for `cwd`, or undefined when it is free (or the path cannot be
 *  resolved — a status read must never throw). */
export function repoLeaseHolder(cwd: string): string | undefined {
  try {
    return leases.get(realpathSync(cwd));
  } catch {
    return undefined;
  }
}

/** The repo a job needs the lease for, or null when it needs none. Only the implement-class
 *  work contends: an `implement` dispatch (worktree or in-place) and `update_pr`; read tiers and
 *  every other tool run freely. Reads raw params (they are validated later, by the handler), so
 *  anything malformed answers null and fails in the handler with its own message. */
export function repoLeaseCwdFor(tool: string, params: Record<string, unknown>): string | null {
  const cwd = params.cwd;
  if (typeof cwd !== "string" || cwd === "") return null;
  if (tool === "update_pr") return cwd;
  if (tool === "dispatch" && params.tier === "implement") return cwd;
  return null;
}

/** Best effort by construction: called from a `finally`, where a throw would replace
 *  whatever the try/catch already decided to report. Deletes the key remembered at acquire;
 *  only for a `cwd` it never saw does it re-resolve, falling back to the raw string if the
 *  path can no longer be resolved. With `jobId`, a lease some OTHER job holds is left alone. */
export function releaseRepoLease(cwd: string, jobId?: string): void {
  const acquired = keyByCwd.get(cwd);
  if (acquired !== undefined) {
    if (jobId !== undefined && leases.get(acquired) !== jobId) return;
    keyByCwd.delete(cwd);
    leases.delete(acquired);
    return;
  }
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
  if (jobId !== undefined && leases.get(key) !== jobId) return;
  leases.delete(key);
}

/** Test-only: drop every lease. The map is process-global and the suite shares one process. */
export function __resetRepoLeasesForTests(): void {
  leases.clear();
  keyByCwd.clear();
}

/** The refusal text a DIRECT caller (no job store: a test, a future non-job caller) gets on a
 *  lease conflict. Submitted jobs never see it — the store queues them instead. */
export function repoLeaseRefusal(holder: string, tool = "dispatch"): string {
  return (
    `${tool} refused: an implement episode is already running in this repo (job ${holder}) — ` +
    `implement episodes serialize per repo because their edits and pushes would interleave. ` +
    `Re-submit once it finishes.`
  );
}
