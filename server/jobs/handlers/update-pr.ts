import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { z } from "zod";
import { appLogger as logger } from "../../logger.ts";
import { resolveDispatchTarget } from "../../lib/dispatch-policy.ts";
import { releaseRepoLease, repoLeaseRefusal, tryAcquireRepoLease } from "../../lib/repo-lease.ts";
import type { ProgressSink } from "../store.ts";
import { parseParams } from "./util.ts";
import { checksBlockPush, renderFailedChecks, runRepoCheck } from "./dispatch.ts";
import {
  createWorktree,
  getPullRequest,
  headOid,
  isRevisableBranch,
  pushBranch,
  rebaseOntoDefault,
  removeWorktree,
  resolveRepoIdentity,
  stripProjectSettings,
  type DispatchWorktree,
} from "./dispatch-git.ts";

// `update_pr` — bring one `dispatch/*` PR up to date with its base, mechanically. Warden's
// merge-train primitive: fetch the PR's branch, rebase it onto the latest default branch,
// re-run the repo's checks on the result, force-with-lease push. No model writes code here —
// a conflict is reported (`status: "conflict"`) and the caller re-dispatches from the new
// base; it is never hand-resolved. Credentials stay in the handler, exactly as for dispatch.

export const UPDATE_PR_INPUT = z.object({
  cwd: z
    .string()
    .min(1)
    .describe(
      "Absolute path of the repo the PR belongs to — same rules as dispatch: directly under a " +
        "configured dispatch root, at implement tier or above (sensitive repos are refused).",
    ),
  pr: z.number().int().positive().describe("Number of the open dispatch/* PR (or GitLab MR)."),
});

export type UpdatePrParams = z.infer<typeof UPDATE_PR_INPUT>;

export const UPDATE_PR_OUTPUT = z.object({
  status: z
    .enum(["updated", "up_to_date", "conflict"])
    .describe(
      "updated = rebased and force-with-lease pushed; up_to_date = the branch already " +
        "contains the latest base (nothing pushed); conflict = the rebase failed, nothing " +
        "pushed — re-dispatch from the new base.",
    ),
  headSha: z.string().describe("The PR head after this job (unchanged for up_to_date/conflict)."),
  previousHeadSha: z.string().describe("The PR head the job started from."),
  baseSha: z.string().optional().describe("The latest base commit the branch now sits on."),
  checks: z
    .object({ passed: z.boolean(), summary: z.string(), failed: z.string().optional() })
    .optional()
    .describe("The repo's own checks run on the rebased tree. Absent on conflict."),
  prUrl: z.string(),
  note: z.string().optional(),
});

export type UpdatePrOutput = z.infer<typeof UPDATE_PR_OUTPUT>;

export async function runUpdatePr(
  rawParams: Record<string, unknown>,
  onProgress?: ProgressSink,
  jobId?: string,
  isCancelled?: (jobId: string) => boolean,
  /** Test seam — the real check is a model session. */
  deps: { runCheckFn?: Parameters<typeof runRepoCheck>[2]["runCheckFn"] } = {},
): Promise<UpdatePrOutput> {
  const { cwd, pr } = parseParams(UPDATE_PR_INPUT, rawParams);
  // Same boundary as an implement dispatch: this pushes to a branch in that repo.
  const decision = resolveDispatchTarget({ cwd, tier: "implement" });
  if (!decision.ok) throw new Error(`update_pr refused: ${decision.reason}`);
  if (decision.sensitive) {
    throw new Error("update_pr refused: sensitive repos have no safe artifact path");
  }
  if (!existsSync(cwd)) throw new Error(`Directory not found: ${cwd}`);
  const note = (lastAction: string): void =>
    onProgress?.({ turns: 0, lastAction, lastActivityAt: Date.now() });

  note("reading PR");
  const identity = await resolveRepoIdentity(cwd);
  const info = await getPullRequest(identity, pr);
  if (info.state !== "open") {
    throw new Error(`update_pr refused: PR #${pr} is ${info.state}, not open`);
  }
  if (!info.sameRepo || !isRevisableBranch(info.headRef)) {
    throw new Error(
      `update_pr refused: PR #${pr} head '${info.headRef}' is not a dispatch/* branch in this repo`,
    );
  }
  if (info.baseRef !== identity.defaultBranch) {
    throw new Error(
      `update_pr refused: PR #${pr} targets '${info.baseRef}', not the default branch ` +
        `'${identity.defaultBranch}'`,
    );
  }

  const jobKey = jobId ?? randomUUID();
  const lease = tryAcquireRepoLease(cwd, jobKey);
  if (!lease.ok) throw new Error(repoLeaseRefusal(lease.holder, "update_pr"));
  let worktree: DispatchWorktree | undefined;
  try {
    note(`fetching ${info.headRef}`);
    worktree = await createWorktree(cwd, jobKey, "update-pr", identity.defaultBranch, info.headRef);
    const previousHeadSha = worktree.remoteHead ?? info.headSha;

    note("rebasing");
    const rebase = await rebaseOntoDefault(worktree, identity.defaultBranch);
    if (!rebase.ok) {
      return {
        status: "conflict",
        headSha: previousHeadSha,
        previousHeadSha,
        prUrl: info.url,
        note: `rebase onto ${identity.defaultBranch} failed: ${rebase.reason}`,
      };
    }

    if (!rebase.rebased) {
      // Nothing moved, so there is nothing new to check or push — and a full check session per
      // poll of an already-current PR is the common, wasteful case.
      logger.info({ event: "update_pr.up_to_date", project: cwd, pr }, "PR already on latest base");
      return {
        status: "up_to_date",
        headSha: previousHeadSha,
        previousHeadSha,
        baseSha: rebase.base,
        prUrl: info.url,
      };
    }

    // The branch content is an earlier episode's output: strip the repo's own agent settings
    // before the check session runs in it, as dispatch does for its worker.
    stripProjectSettings(worktree);
    const check = await runRepoCheck(worktree.path, note, {
      jobId,
      isCancelled,
      runCheckFn: deps.runCheckFn,
    });
    const blocking = checksBlockPush(check);
    const checks = {
      passed: !blocking,
      summary: check.summary,
      ...(blocking ? { failed: renderFailedChecks(check.steps) } : {}),
    };

    // Pushed even when the checks are red: the rebased tree is what would merge, CI should
    // see it, and the train decides from `checks`. The lease pins the push to the tip read
    // above, so a commit someone pushed meanwhile fails it instead of being overwritten.
    note(`pushing ${worktree.branch}`);
    await pushBranch(worktree, identity);
    const headSha = await headOid(worktree);
    logger.info(
      { event: "update_pr.pushed", project: cwd, pr, headSha, checksPassed: checks.passed },
      "PR rebased and pushed",
    );
    return UPDATE_PR_OUTPUT.parse({
      status: "updated",
      headSha,
      previousHeadSha,
      baseSha: rebase.base,
      checks,
      prUrl: info.url,
    });
  } finally {
    if (worktree) await removeWorktree(cwd, worktree);
    releaseRepoLease(cwd);
  }
}
