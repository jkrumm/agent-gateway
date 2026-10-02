// Wave 2 — dispatch git safety: continuing a prior `dispatch/*` branch (`revisionOf`), the
// rebase onto the latest default before any push, and the force-with-lease push that makes a
// rebased branch updatable. Real git against a local bare origin, like dispatch-worktree.test.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { randomUUID } from "crypto";
import {
  commitPendingWork,
  createWorktree,
  isRevisableBranch,
  pushBranch,
  rebaseOntoDefault,
  type RepoIdentity,
} from "../server/jobs/handlers/dispatch-git.ts";
import {
  DISPATCH_OUTCOMES,
  DISPATCH_SCHEMA_VERSION,
  depositBranch,
  runDispatch,
  type DispatchOutput,
} from "../server/jobs/handlers/dispatch.ts";
import { runUpdatePr, UPDATE_PR_INPUT } from "../server/jobs/handlers/update-pr.ts";
import {
  releaseRepoLease,
  repoLeaseRefusal,
  tryAcquireRepoLease,
} from "../server/lib/repo-lease.ts";
import { Fixture, git, makeFixture } from "./git-fixture.ts";

let fx: Fixture;

beforeEach(async () => {
  fx = await makeFixture();
});

afterEach(() => {
  fx.cleanup();
});

const ID: RepoIdentity = {
  owner: "jkrumm",
  repo: "fixture",
  defaultBranch: "master",
  kind: "github",
};
const key = (): string => randomUUID();

function verdict(): DispatchOutput {
  return {
    verdict: "v",
    confidence: "medium",
    evidence: [],
    recommendation: "r",
    nextAction: "none",
    summary: "s",
    outcome: "verdict_only",
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    prTitle: "",
    prBody: "",
  };
}

const passingCheck = async () => ({ passed: true as const, steps: [], summary: "stub" });

/** An earlier episode's branch on origin: one commit touching `file`, pushed as `branch`. */
async function seedPriorBranch(branch: string, file = "prior.txt"): Promise<string> {
  await git(["checkout", "-q", "-b", branch], fx.repo);
  fx.write(file, "prior work\n");
  const oid = await fx.commit("prior episode");
  await git(["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`], fx.repo);
  await git(["checkout", "-q", "master"], fx.repo);
  await git(["branch", "-q", "-D", branch], fx.repo);
  return oid;
}

/** Land a commit on origin's master from the live checkout. */
async function advanceMaster(file: string, contents: string): Promise<string> {
  fx.write(file, contents);
  const oid = await fx.commit(`master moves: ${file}`);
  await git(["push", "-q", "origin", "master"], fx.repo);
  return oid;
}

describe("isRevisableBranch", () => {
  test("accepts dispatch/<slug>, rejects everything else", () => {
    expect(isRevisableBranch("dispatch/fix-the-bug-1a2b3c4d")).toBe(true);
    expect(isRevisableBranch("dispatch/read-1a2b3c4d")).toBe(false);
    expect(isRevisableBranch("master")).toBe(false);
    expect(isRevisableBranch("dispatch/../master")).toBe(false);
    expect(isRevisableBranch("dispatch/-x")).toBe(false);
    expect(isRevisableBranch("feature/x")).toBe(false);
  });
});

describe("createWorktree with revisionOf", () => {
  test("continues the prior branch: same name, cut from its fetched tip, lease pinned", async () => {
    const prior = await seedPriorBranch("dispatch/prior-aaaa1111");
    const wt = await createWorktree(fx.repo, key(), "ignored", "master", "dispatch/prior-aaaa1111");
    expect(wt.branch).toBe("dispatch/prior-aaaa1111");
    expect(wt.base).toBe(prior);
    expect(wt.remoteHead).toBe(prior);
    expect(wt.pushable).toBe(true);
    expect(await git(["rev-parse", "HEAD"], wt.path)).toBe(prior);
    expect(existsSync(join(wt.path, "prior.txt"))).toBe(true);
  });

  test("refuses a branch outside dispatch/ and one that is not on origin", async () => {
    await expect(createWorktree(fx.repo, key(), "x", "master", "master")).rejects.toThrow(
      /must name a dispatch\/\* branch/,
    );
    await expect(
      createWorktree(fx.repo, key(), "x", "master", "dispatch/ghost-00000000"),
    ).rejects.toThrow(/cannot fetch revisionOf branch/);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });
});

describe("rebaseOntoDefault", () => {
  test("a branch already on the latest base is left alone", async () => {
    const wt = await createWorktree(fx.repo, key(), "uptodate", "master");
    const r = await rebaseOntoDefault(wt, "master");
    expect(r).toEqual({ ok: true, base: wt.base, rebased: false });
  });

  test("a clean rebase moves the branch onto the new base", async () => {
    const wt = await createWorktree(fx.repo, key(), "clean", "master");
    fx.write("ours.txt", "ours\n", wt.path);
    await commitPendingWork(wt, "our change");
    const newBase = await advanceMaster("theirs.txt", "theirs\n");

    const r = await rebaseOntoDefault(wt, "master");
    expect(r).toEqual({ ok: true, base: newBase, rebased: true });
    expect(
      await git(["merge-base", "--is-ancestor", newBase, "HEAD"], wt.path).then(() => true),
    ).toBe(true);
    expect(existsSync(join(wt.path, "theirs.txt"))).toBe(true);
    expect(existsSync(join(wt.path, "ours.txt"))).toBe(true);
  });

  test("a conflict aborts the rebase and leaves the branch exactly as committed", async () => {
    const wt = await createWorktree(fx.repo, key(), "conflict", "master");
    fx.write("README.md", "ours\n", wt.path);
    const tip = await commitPendingWork(wt, "our change").then(() =>
      git(["rev-parse", "HEAD"], wt.path),
    );
    await advanceMaster("README.md", "theirs\n");

    const r = await rebaseOntoDefault(wt, "master");
    expect(r.ok).toBe(false);
    expect(await git(["rev-parse", "HEAD"], wt.path)).toBe(tip);
    expect(await git(["status", "--porcelain"], wt.path)).toBe("");
    const gitDir = await git(["rev-parse", "--git-dir"], wt.path);
    expect(existsSync(join(wt.path, gitDir, "rebase-merge"))).toBe(false);
  });
});

describe("rebase safety", () => {
  test("a fetch failure fails the job instead of rebasing onto a stale base", async () => {
    const wt = await createWorktree(fx.repo, key(), "offline", "master");
    await git(["remote", "set-url", "origin", join(fx.root, "gone.git")], fx.repo);
    await expect(rebaseOntoDefault(wt, "master")).rejects.toThrow(/could not fetch origin\/master/);
  });

  test("a stale local dispatch/* branch does not block a revision", async () => {
    await seedPriorBranch("dispatch/stale-eeee5555");
    await git(["branch", "dispatch/stale-eeee5555", "master"], fx.repo);
    const wt = await createWorktree(fx.repo, key(), "x", "master", "dispatch/stale-eeee5555");
    expect(existsSync(join(wt.path, "prior.txt"))).toBe(true);
  });

  test("an implement slug that starts with read- is still revisable", () => {
    expect(isRevisableBranch("dispatch/read-the-docs-1a2b3c4d")).toBe(true);
    expect(isRevisableBranch("dispatch/read-1a2b3c4d")).toBe(false);
  });
});

describe("pushBranch with a lease", () => {
  test("a rebased revision is pushed over the prior tip", async () => {
    await seedPriorBranch("dispatch/lease-bbbb2222");
    const wt = await createWorktree(fx.repo, key(), "x", "master", "dispatch/lease-bbbb2222");
    fx.write("more.txt", "revision\n", wt.path);
    await commitPendingWork(wt, "revision");
    await advanceMaster("elsewhere.txt", "x\n");
    expect((await rebaseOntoDefault(wt, "master")).ok).toBe(true);

    await pushBranch(wt, ID);
    expect((await fx.originRefs())["dispatch/lease-bbbb2222"]).toBe(
      await git(["rev-parse", "HEAD"], wt.path),
    );
  });

  test("fails — and overwrites nothing — when the remote branch moved since the fetch", async () => {
    await seedPriorBranch("dispatch/lease-cccc3333");
    const wt = await createWorktree(fx.repo, key(), "x", "master", "dispatch/lease-cccc3333");
    fx.write("more.txt", "revision\n", wt.path);
    await commitPendingWork(wt, "revision");

    fx.write("theirs.txt", "pushed meanwhile\n");
    const theirs = await fx.commit("someone else");
    await git(
      ["push", "-q", "--force", "origin", `HEAD:refs/heads/dispatch/lease-cccc3333`],
      fx.repo,
    );

    await expect(pushBranch(wt, ID)).rejects.toThrow();
    expect((await fx.originRefs())["dispatch/lease-cccc3333"]).toBe(theirs);
  });
});

describe("depositBranch — rebase before push", () => {
  test("a conflict returns `conflict`, pushes nothing", async () => {
    const wt = await createWorktree(fx.repo, key(), "conf", "master");
    fx.write("README.md", "ours\n", wt.path);
    await advanceMaster("README.md", "theirs\n");

    const r = await depositBranch(wt, ID, verdict(), () => {}, { runCheckFn: passingCheck });
    expect(r.outcome).toBe("conflict");
    expect(r.note).toMatch(/Nothing was pushed/);
    expect(r.note).toMatch(/bundled at/);
    expect(Object.keys(await fx.originRefs())).toEqual(["master"]);
  });

  test("a clean rebase is pushed on top of the new base", async () => {
    const wt = await createWorktree(fx.repo, key(), "clean", "master");
    fx.write("ours.txt", "ours\n", wt.path);
    const newBase = await advanceMaster("theirs.txt", "theirs\n");

    const r = await depositBranch(wt, ID, verdict(), () => {}, { runCheckFn: passingCheck });
    expect(r.outcome).toBe("branch_no_pr");
    const pushed = (await fx.originRefs())[wt.branch];
    expect(pushed).toBeDefined();
    await git(["merge-base", "--is-ancestor", newBase, pushed as string], fx.origin);
  });
});

describe("outcome vocabulary", () => {
  test("carries pr_updated and conflict", () => {
    expect(DISPATCH_OUTCOMES).toContain("pr_updated");
    expect(DISPATCH_OUTCOMES).toContain("conflict");
  });
});

describe("runDispatch — revisionOf refusals", () => {
  test.each([
    [{ tier: "investigate" }, /revisionOf is only valid/],
    [{ tier: "implement", workspace: "in-place" }, /revisionOf is only valid/],
    [{ tier: "implement", revisionOf: "master" }, /must name a dispatch\/<slug> branch/],
  ])("%j is refused before any worktree exists", async (extra, message) => {
    await expect(
      runDispatch({ cwd: fx.repo, brief: "b", revisionOf: "dispatch/x-12345678", ...extra }),
    ).rejects.toThrow(message);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });
});

describe("repo lease", () => {
  test("a second holder is told who has it; release frees it", () => {
    expect(tryAcquireRepoLease(fx.repo, "job-a").ok).toBe(true);
    const second = tryAcquireRepoLease(fx.repo, "job-b");
    expect(second).toEqual({ ok: false, holder: "job-a" });
    expect(repoLeaseRefusal("job-a")).toMatch(/already running in this repo \(job job-a\)/);
    releaseRepoLease(fx.repo);
    expect(tryAcquireRepoLease(fx.repo, "job-b").ok).toBe(true);
    releaseRepoLease(fx.repo);
  });
});

// A `glab` on PATH that answers `merge_requests/<n>` GETs with whatever $GLAB_MR_JSON holds, and
// a GitLab-shaped origin URL rewritten onto the fixture's local bare repo — so runUpdatePr's
// identity resolution, MR lookup, fetch, rebase and push all run for real, offline.
describe("runUpdatePr against a stubbed GitLab MR", () => {
  let binDir: string;
  let savedPath: string | undefined;
  const BRANCH = "dispatch/mr-dddd4444";

  const mr = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      web_url: "https://gitlab.com/jkrumm/fixture/-/merge_requests/5",
      iid: 5,
      state: "opened",
      source_branch: BRANCH,
      target_branch: "master",
      sha: "0".repeat(40),
      source_project_id: 1,
      target_project_id: 1,
      ...over,
    });

  beforeEach(async () => {
    binDir = mkdtempSync(join(tmpdir(), "sideclaw-glab-"));
    writeFileSync(join(binDir, "glab"), "#!/bin/sh\nprintf '%s' \"$GLAB_MR_JSON\"\n");
    chmodSync(join(binDir, "glab"), 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath ?? ""}`;
    const url = "https://gitlab.com/jkrumm/fixture.git";
    await git(["config", `url.${fx.origin}.insteadOf`, url], fx.repo);
    await git(["config", "remote.origin.url", url], fx.repo);
    // The bare origin needs HEAD → master for `ls-remote --symref`, which init -b already gives.
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.GLAB_MR_JSON;
    rmSync(binDir, { recursive: true, force: true });
  });

  const update = (deps = { runCheckFn: passingCheck }) =>
    runUpdatePr({ cwd: fx.repo, pr: 5 }, undefined, undefined, undefined, deps);

  test.each([
    ["a closed MR", { state: "closed" }, /is closed, not open/],
    ["a fork MR", { target_project_id: 2 }, /not a dispatch\/\* branch in this repo/],
    ["a non-dispatch head", { source_branch: "feature/x" }, /not a dispatch\/\* branch/],
    ["a MR into another branch", { target_branch: "release" }, /targets 'release'/],
  ])("refuses %s before touching git", async (_name, over, message) => {
    process.env.GLAB_MR_JSON = mr(over);
    await expect(update()).rejects.toThrow(message);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });

  test("a response missing fields fails loudly instead of passing the safety checks", async () => {
    process.env.GLAB_MR_JSON = JSON.stringify({ web_url: "u", iid: 5, state: "opened" });
    await expect(update()).rejects.toThrow(/unexpected merge request shape/);
  });

  test("up_to_date: nothing pushed, no check run", async () => {
    const tip = await seedPriorBranch(BRANCH);
    process.env.GLAB_MR_JSON = mr({ sha: tip });
    let checked = false;
    const r = await update({
      runCheckFn: async () => {
        checked = true;
        return passingCheck();
      },
    });
    expect(r.status).toBe("up_to_date");
    expect(r.headSha).toBe(tip);
    expect(checked).toBe(false);
  });

  test("updated: rebased onto the new base and pushed over the old tip", async () => {
    const tip = await seedPriorBranch(BRANCH);
    const newBase = await advanceMaster("moved.txt", "x\n");
    process.env.GLAB_MR_JSON = mr({ sha: tip });
    const r = await update();
    expect(r.status).toBe("updated");
    expect(r.previousHeadSha).toBe(tip);
    expect(r.baseSha).toBe(newBase);
    expect(r.checks?.passed).toBe(true);
    expect((await fx.originRefs())[BRANCH]).toBe(r.headSha);
    expect(r.headSha).not.toBe(tip);
    expect(await fx.linkedWorktrees()).toEqual([]);
  });

  test("conflict: reported, nothing pushed, lease released", async () => {
    const tip = await seedPriorBranch(BRANCH, "README.md");
    await advanceMaster("README.md", "conflicting\n");
    process.env.GLAB_MR_JSON = mr({ sha: tip });
    const r = await update();
    expect(r.status).toBe("conflict");
    expect((await fx.originRefs())[BRANCH]).toBe(tip);
    expect(tryAcquireRepoLease(fx.repo, "after").ok).toBe(true);
    releaseRepoLease(fx.repo);
  });

  test("a second update while the lease is held is refused", async () => {
    await seedPriorBranch(BRANCH);
    process.env.GLAB_MR_JSON = mr();
    tryAcquireRepoLease(fx.repo, "job-busy");
    try {
      await expect(update()).rejects.toThrow(/update_pr refused: .*\(job job-busy\)/);
    } finally {
      releaseRepoLease(fx.repo);
    }
  });
});

describe("update_pr", () => {
  test("input needs a positive integer PR number", () => {
    expect(UPDATE_PR_INPUT.safeParse({ cwd: "/r", pr: 3 }).success).toBe(true);
    expect(UPDATE_PR_INPUT.safeParse({ cwd: "/r", pr: 0 }).success).toBe(false);
    expect(UPDATE_PR_INPUT.safeParse({ cwd: "/r", pr: 1.5 }).success).toBe(false);
  });

  test("a repo outside every dispatch root is refused before any forge call", async () => {
    await expect(runUpdatePr({ cwd: "/etc", pr: 1 })).rejects.toThrow(/update_pr refused/);
  });
});
