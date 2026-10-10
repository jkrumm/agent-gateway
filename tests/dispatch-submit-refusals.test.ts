// Every refusal that is knowable at submit time is a synchronous 400 from POST /api/jobs, with
// no job row created (server/routes/jobs.ts → dispatchSubmitRefusal). The handler repeats each
// check; this file pins the route half, plus the happy path that must still be accepted.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { __resetForTests, listJobs } from "../server/jobs/store.ts";
import { jobsRoutes } from "../server/routes/jobs.ts";
import { git, makeFixture, type Fixture } from "./git-fixture.ts";

// No executor registered: an accepted job stays `pending` instead of running.
beforeAll(() => __resetForTests());
afterAll(() => __resetForTests());

let fx: Fixture;
beforeEach(async () => {
  fx = await makeFixture();
});
afterEach(() => {
  __resetForTests();
  fx.cleanup();
});

async function post(params: Record<string, unknown>) {
  const res = await jobsRoutes.handle(
    new Request("http://localhost/api/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "dispatch", params }),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok: boolean; error?: string } };
}

/** Submit, expect a 400 matching `pattern`, and prove no job row was created. */
async function expectRefused(params: Record<string, unknown>, pattern: RegExp) {
  const before = listJobs().length;
  const { status, body } = await post(params);
  expect(status).toBe(400);
  expect(body.ok).toBe(false);
  expect(body.error).toMatch(pattern);
  expect(listJobs().length).toBe(before);
}

const impl = (extra: Record<string, unknown> = {}) => ({
  cwd: fx.repo,
  brief: "change it",
  tier: "implement",
  ...extra,
});

describe("static refusals are synchronous 400s with no job row", () => {
  test("in-place with a tier other than implement", async () => {
    await expectRefused(
      { cwd: fx.repo, brief: "b", tier: "investigate", workspace: "in-place" },
      /dispatch refused:.*in-place/,
    );
  });

  test("sensitive: true with a tier other than investigate", async () => {
    await expectRefused(impl({ sensitive: true }), /sensitive dispatch refused/);
  });

  test("revisionOf on a tier/workspace that cannot revise", async () => {
    await expectRefused(
      { cwd: fx.repo, brief: "b", tier: "investigate", revisionOf: "dispatch/x-1a2b3c4d" },
      /revisionOf is only valid/,
    );
    await expectRefused(
      impl({ workspace: "in-place", revisionOf: "dispatch/x-1a2b3c4d" }),
      /refused/,
    );
  });

  test("revisionOf naming something outside dispatch/", async () => {
    await expectRefused(impl({ revisionOf: "feature/x" }), /revisionOf must name a dispatch/);
    await expectRefused(impl({ revisionOf: "dispatch/../master" }), /revisionOf must name/);
  });

  test("in-place on the opencode harness in a repo carrying its own opencode config", async () => {
    fx.write(".opencode/plugin.js", "module.exports = () => {}\n");
    await expectRefused(impl({ workspace: "in-place" }), /dispatch refused:.*\.opencode/);
  });

  test("...but an editorial in-place episode (claude harness) is accepted in that repo", async () => {
    fx.write(".opencode/plugin.js", "module.exports = () => {}\n");
    const { status, body } = await post(impl({ workspace: "in-place", kind: "editorial" }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
  });

  test("malformed params, including an unknown kind", async () => {
    await expectRefused(impl({ kind: "prose" }), /invalid params.*kind/);
    await expectRefused({ cwd: fx.repo, tier: "implement" }, /invalid params.*brief/);
  });
});

describe("branch and prTitle", () => {
  test("an invalid branch slug is refused, naming the problem", async () => {
    const bad: [string, RegExp][] = [
      ["Bad Branch", /may only contain/],
      ["UPPER", /may only contain/],
      ["a..b", /'\.\.'/],
      ["-leading", /may only contain/],
      ["trailing/", /must not end/],
      ["a//b", /empty path component/],
      ["a/.hidden", /start with '\.'/],
      ["topic.lock", /\.lock/],
      ["read-1a2b3c4d", /throwaway/],
      ["x".repeat(65), /invalid params/],
    ];
    for (const [branch, pattern] of bad) await expectRefused(impl({ branch }), pattern);
  });

  test("branch is only valid for an implement worktree episode without revisionOf", async () => {
    await expectRefused(
      { cwd: fx.repo, brief: "b", tier: "investigate", branch: "ok-name" },
      /branch is only valid/,
    );
    await expectRefused(impl({ workspace: "in-place", branch: "ok-name" }), /branch is only valid/);
    await expectRefused(
      impl({ revisionOf: "dispatch/x-1a2b3c4d", branch: "ok-name" }),
      /branch is only valid/,
    );
  });

  test("prTitle must be a non-empty single line within the cap, and only for an implement worktree", async () => {
    await expectRefused(impl({ prTitle: "   " }), /prTitle must be 1-200/);
    await expectRefused(impl({ prTitle: "x".repeat(201) }), /prTitle.*200 characters/);
    await expectRefused(impl({ prTitle: "two\nlines" }), /single line/);
    await expectRefused(
      { cwd: fx.repo, brief: "b", tier: "investigate", prTitle: "feat: x" },
      /prTitle is only valid/,
    );
    await expectRefused(
      impl({ workspace: "in-place", prTitle: "feat: x" }),
      /prTitle is only valid/,
    );
  });

  test("a name that already exists on origin is refused, as is one nested under it or above it", async () => {
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/taken"], fx.repo);
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/group/inner"], fx.repo);
    await expectRefused(impl({ branch: "taken" }), /collides with the existing branch/);
    await expectRefused(impl({ branch: "taken/child" }), /collides with the existing branch/);
    await expectRefused(impl({ branch: "group" }), /collides with the existing branch/);
  });

  test("a name that exists only as a local branch is refused too", async () => {
    await git(["branch", "dispatch/local-only"], fx.repo);
    await expectRefused(impl({ branch: "local-only" }), /collides with the existing branch/);
  });

  test("a free name, a sibling of an existing one and a valid title are accepted", async () => {
    await git(["push", "-q", "origin", "HEAD:refs/heads/dispatch/group/inner"], fx.repo);
    for (const params of [
      impl({ branch: "fresh.name_1/part-2", prTitle: "docs: reword AGENTS.md" }),
      impl({ branch: "group/sibling" }),
      impl({ kind: "editorial", prTitle: "docs: x" }),
    ]) {
      const { status, body } = await post(params);
      expect(status).toBe(200);
      expect(body.ok).toBe(true);
    }
    expect(listJobs().length).toBe(3);
  });
});
