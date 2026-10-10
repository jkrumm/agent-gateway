// Caller-controlled naming for the implement tier: the `branch` slug (`dispatch/<slug>`), the
// `prTitle` override, and the capped auto-name. Real temp git repos via tests/git-fixture.ts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "crypto";
import {
  assertNamingAllowed,
  depositBranch,
  DISPATCH_SCHEMA_VERSION,
  fallbackWithheldOf,
  type DispatchOutput,
} from "../server/jobs/handlers/dispatch.ts";
import {
  AUTO_SLUG_MAX,
  autoBranchSlug,
  BRANCH_SLUG_MAX,
  branchSlugProblem,
  commitPendingWork,
  createWorktree,
  findBranchCollision,
  isRevisableBranch,
  pushBranch,
  type RepoIdentity,
} from "../server/jobs/handlers/dispatch-git.ts";
import { git, makeFixture, type Fixture } from "./git-fixture.ts";

let fx: Fixture;
beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => fx.cleanup());

const ID: RepoIdentity = {
  owner: "jkrumm",
  repo: "fixture",
  defaultBranch: "master",
  kind: "github",
};

describe("branchSlugProblem / isRevisableBranch", () => {
  test("accepts the documented charset and shapes", () => {
    for (const slug of ["fix", "a.b", "a_b", "a/b/c", "v1.2.3-rc1", "docs/reword-agents", "0day"]) {
      expect(branchSlugProblem(slug)).toBeNull();
      expect(isRevisableBranch(`dispatch/${slug}`)).toBe(true);
    }
    expect(branchSlugProblem("x".repeat(BRANCH_SLUG_MAX))).toBeNull();
  });

  test("rejects everything git or this tool cannot hold", () => {
    const bad = [
      "",
      "x".repeat(BRANCH_SLUG_MAX + 1),
      "Upper",
      "has space",
      "-x",
      ".x",
      "a..b",
      "a//b",
      "a/",
      "a.",
      "a/.b",
      "a.lock",
      "a/b.lock",
      "a~b",
      "a^b",
      "a:b",
      "a?b",
      "a*b",
      "a[b",
      "a\\b",
      "a@{b",
      "read-1a2b3c4d",
    ];
    for (const slug of bad) {
      expect(branchSlugProblem(slug)).not.toBeNull();
      expect(isRevisableBranch(`dispatch/${slug}`)).toBe(false);
    }
  });

  test("git itself accepts every slug the validator accepts", async () => {
    for (const slug of ["fix", "a.b", "a_b", "a/b/c", "v1.2.3-rc1", "0day"]) {
      const proc = Bun.spawn(["git", "check-ref-format", `refs/heads/dispatch/${slug}`]);
      expect(await proc.exited).toBe(0);
    }
  });

  test("the old auto-name shape and the read-tier throwaway keep their classification", () => {
    expect(isRevisableBranch("dispatch/fix-the-bug-1a2b3c4d")).toBe(true);
    expect(isRevisableBranch("dispatch/read-1a2b3c4d")).toBe(false);
    expect(isRevisableBranch("dispatch/read-the-docs-1a2b3c4d")).toBe(true);
    expect(isRevisableBranch("master")).toBe(false);
  });
});

describe("autoBranchSlug", () => {
  test("is capped and cut at a word boundary", () => {
    const brief =
      "Remove OpenSpec scaffolding from prometheus-scripts and update the README accordingly";
    const slug = autoBranchSlug(brief);
    expect(slug.length).toBeLessThanOrEqual(AUTO_SLUG_MAX);
    expect(slug).toBe("remove-openspec-scaffolding-from");
    expect(brief.toLowerCase()).toContain(slug.split("-").at(-1) as string);
  });

  test("short briefs pass through; one giant word is hard-cut; empty falls back", () => {
    expect(autoBranchSlug("Fix the login bug")).toBe("fix-the-login-bug");
    expect(autoBranchSlug("a".repeat(100))).toBe("a".repeat(AUTO_SLUG_MAX));
    expect(autoBranchSlug("!!!")).toBe("work");
  });
});

describe("assertNamingAllowed", () => {
  const ok = { tier: "implement", workspace: "worktree" } as const;

  test("accepts a valid pair on an implement worktree episode", () => {
    expect(() => assertNamingAllowed({ ...ok, branch: "x-y", prTitle: "feat: x" })).not.toThrow();
    expect(() => assertNamingAllowed({ ...ok })).not.toThrow();
    // prTitle with revisionOf is fine (commit subject); branch is not.
    expect(() =>
      assertNamingAllowed({ ...ok, revisionOf: "dispatch/a-1", prTitle: "x" }),
    ).not.toThrow();
    expect(() => assertNamingAllowed({ ...ok, revisionOf: "dispatch/a-1", branch: "x" })).toThrow(
      /branch is only valid/,
    );
  });

  test("refuses naming params on any other tier/workspace instead of ignoring them", () => {
    expect(() =>
      assertNamingAllowed({ tier: "author", workspace: "worktree", branch: "x" }),
    ).toThrow();
    expect(() =>
      assertNamingAllowed({ tier: "implement", workspace: "in-place", prTitle: "x" }),
    ).toThrow(/prTitle is only valid/);
  });
});

describe("createWorktree with a caller-chosen slug", () => {
  test("the branch is exactly dispatch/<slug>, no job-id suffix", async () => {
    const wt = await createWorktree(
      fx.repo,
      randomUUID(),
      "ignored",
      "master",
      undefined,
      "my.topic/part-1",
    );
    expect(wt.branch).toBe("dispatch/my.topic/part-1");
    expect(isRevisableBranch(wt.branch)).toBe(true);
    expect((await fx.localBranches()).includes("dispatch/my.topic/part-1")).toBe(true);
  });

  test("without a slug the auto-name still carries the job-id suffix", async () => {
    const key = randomUUID();
    const wt = await createWorktree(fx.repo, key, "auto-name", "master");
    expect(wt.branch).toBe(`dispatch/auto-name-${key.slice(0, 8)}`);
  });
});

describe("findBranchCollision", () => {
  test("null for a free name, a sibling and a name only a stale remote-tracking ref remembers", async () => {
    expect(await findBranchCollision(fx.repo, "dispatch/free")).toBeNull();
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/group/inner"], fx.repo);
    expect(await findBranchCollision(fx.repo, "dispatch/group/sibling")).toBeNull();
    // Fetch it, then delete it upstream: the remote-tracking ref goes stale but the name is free.
    await git(["fetch", "-q", "origin"], fx.repo);
    await git(["push", "-q", "origin", "--delete", "dispatch/group/inner"], fx.repo);
    expect(await findBranchCollision(fx.repo, "dispatch/group/inner")).toBeNull();
  });

  test("reports the same name, a nested one and an ancestor on origin, and a local leftover", async () => {
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/taken"], fx.repo);
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/deep/er"], fx.repo);
    expect(await findBranchCollision(fx.repo, "dispatch/taken")).toBe("dispatch/taken");
    expect(await findBranchCollision(fx.repo, "dispatch/taken/child")).toBe("dispatch/taken");
    expect(await findBranchCollision(fx.repo, "dispatch/deep")).toBe("dispatch/deep/er");
    await git(["branch", "dispatch/leftover"], fx.repo);
    expect(await findBranchCollision(fx.repo, "dispatch/leftover")).toBe("dispatch/leftover");
  });

  test("an unreachable origin is not a collision", async () => {
    await git(["remote", "set-url", "origin", "/nonexistent/origin.git"], fx.repo);
    expect(await findBranchCollision(fx.repo, "dispatch/anything")).toBeNull();
  });
});

// A red check stops the flow right after the push (no PR call, no network), which is exactly
// enough to read the commit subject the title override produced.
const failingCheck = async () => ({
  passed: false as const,
  steps: [{ name: "lint", passed: false as const, errors: ["x"] }],
  summary: "1/1 failed",
});

describe("depositBranch with a caller prTitle", () => {
  function verdict(overrides: Partial<DispatchOutput> = {}): DispatchOutput {
    return {
      verdict: "v",
      confidence: "medium",
      evidence: [],
      recommendation: "r",
      nextAction: "none",
      summary: "s",
      outcome: "verdict_only",
      schemaVersion: DISPATCH_SCHEMA_VERSION,
      prTitle: "worker: its own title",
      prBody: "worker body",
      ...overrides,
    };
  }
  test("the caller's title is the commit subject; the worker's is the fallback", async () => {
    for (const [callerTitle, expected] of [
      ["docs: caller title", "docs: caller title"],
      [undefined, "worker: its own title"],
    ] as const) {
      const wt = await createWorktree(fx.repo, randomUUID(), "t", "master");
      fx.write(`f-${expected.length}.txt`, "x\n", wt.path);
      const result = await depositBranch(
        wt,
        ID,
        verdict(),
        () => {},
        { runCheckFn: failingCheck },
        callerTitle,
      );
      expect(result.outcome).toBe("checks_failed");
      const subject = await git(["log", "-1", "--format=%s", "HEAD"], wt.path);
      expect(subject).toBe(expected);
    }
  });

  test("pushBranch accepts a caller-named branch (dispatch/ namespace, slash and dot included)", async () => {
    const wt = await createWorktree(
      fx.repo,
      randomUUID(),
      "t",
      "master",
      undefined,
      "named.by/caller",
    );
    fx.write("g.txt", "x\n", wt.path);
    await commitPendingWork(wt, "c");
    await pushBranch(wt, ID);
    expect(Object.keys(await fx.originRefs())).toContain("dispatch/named.by/caller");
  });
});

describe("fallbackWithheldOf", () => {
  test("reads the session result's typed field, tolerating its absence", () => {
    expect(fallbackWithheldOf({ ok: true })).toBeUndefined();
    expect(
      fallbackWithheldOf({ ok: false, fallbackWithheld: "write-tier-after-output" } as never),
    ).toBe("write-tier-after-output");
    expect(
      fallbackWithheldOf({ ok: false, fallbackWithheld: "something-else" } as never),
    ).toBeUndefined();
  });
});
